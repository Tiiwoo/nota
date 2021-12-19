import fs from "fs";
import yargs from "yargs";
import esbuild, { BuildOptions, BuildResult, Plugin, Loader } from "esbuild";
import type { IPackageJson, IDependencyMap } from "package-json-type";
import { EsmExternalsPlugin } from "@esbuild-plugins/esm-externals";
import path from "path";
import _ from "lodash";
import { promise as glob } from "glob-promise";

export let cli = (): ((_extra: BuildOptions) => Promise<[BuildResult, BuildOptions]>) => {
  let options = yargs(process.argv.slice(2)).alias("w", "watch").alias("p", "prod").argv as any;

  let pkg: IPackageJson = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  let keys = (map?: IDependencyMap) => Object.keys(map || {});
  let pkg_external = keys(pkg.dependencies).concat(keys(pkg.peerDependencies));

  return (extra: BuildOptions) => {
    let external = pkg_external.concat(extra.external || []);
    let plugins = extra.plugins || [];
    let format = extra.format || "esm";
    if (format == "esm") {
      plugins.push(EsmExternalsPlugin({ externals: external }));
    }

    let loader: { [ext: string]: Loader } = {
      ".otf": "file",
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".wasm": "file",
      ".bib": "text",
      ...(extra.loader || {}),
    };

    let outpaths: BuildOptions = {};
    if (extra.outdir) {
      outpaths.outdir = extra.outdir;
    } else if (extra.outfile) {
      outpaths.outfile = extra.outfile;
    } else {
      extra.outdir = "dist";
    }

    let opts = {
      ...extra,
      ...outpaths,
      watch: options.watch,
      minify: options.prod,
      external,
      plugins,
      format,
      loader,
      bundle: extra.bundle !== undefined ? extra.bundle : true,
      sourcemap: extra.sourcemap !== undefined ? extra.sourcemap : true,
    };

    return esbuild.build(opts).then(result => [result, opts]);
  };
};

export let copy_plugin = ({ extensions }: { extensions: string[] }): Plugin => ({
  name: "copy",
  setup(build) {
    let outdir = build.initialOptions.outdir;
    if (!outdir) {
      throw `outdir must be specified`;
    }

    let paths: [string, string][] = [];
    let filter = new RegExp(extensions.map(_.escapeRegExp).join("|"));
    build.onResolve({ filter }, async args => {
      let abs_path = path.join(args.resolveDir, args.path);
      let matching_paths = await glob(abs_path);
      paths = paths.concat(matching_paths.map(p => [p, path.join(outdir, path.basename(p))]));
      return { path: args.path, namespace: "copy" };
    });

    build.onLoad({ filter: /.*/, namespace: "copy" }, async _args => ({ contents: "" }));
    build.onEnd(_ => {
      paths.forEach(([inpath, outpath]) => fs.promises.copyFile(inpath, outpath));
    });
  },
});
