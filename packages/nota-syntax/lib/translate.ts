import { SyntaxNode, Tree } from "@lezer/common";
import * as t from "./babel-polyfill";
//@ts-ignore
import * as terms from "./nota.terms";
import _, { transform } from "lodash";
import type { Expression, Statement, LVal, SpreadElement } from "@babel/types";
import type { PluginObj } from "@babel/core";
import { transformFromAst } from "@babel/standalone";
import * as nota from "@wcrichto/nota";
import { INTRINSIC_ELEMENTS } from "./intrinsic-elements";

const assert = console.assert;

let matches = (node: SyntaxNode, term: number): boolean => node.type.id == term;
let matches_newline = (node: SyntaxNode): boolean =>
  matches(node, terms.Newline) || matches(node, terms.Multinewline);

let global: {
  input: string;
  used_prelude: Set<string>;
  imports: Set<string>;
} = {
  input: "",
  used_prelude: new Set(),
  imports: new Set(),
};

let react_id = t.identifier("React");
let globals_arg = t.identifier("globals");
let imports_arg = t.identifier("imports");
let create_el = t.identifier("el");

let to_react = (
  name: Expression,
  props: { [key: string]: Expression },
  children: (Expression | SpreadElement)[]
): Expression => {
  let args: (Expression | SpreadElement)[] = [
    name,
    t.objectExpression(Object.keys(props).map(k => t.objectProperty(t.stringLiteral(k), props[k]))),
  ];
  return t.callExpression(create_el, args.concat(children));
};

let text = (cursor: SyntaxNode): string => global.input.slice(cursor.from, cursor.to);

export type TranslatedFunction = (
  _symbols: { [key: string]: any },
  _imports: { [path: string]: any }
) => JSX.Element;

export interface Translation {
  js: string;
  imports: Set<string>;
}

export let PRELUDE: Set<string> = new Set(Object.keys(nota));

let binding = (k: LVal, v: Expression) =>
  t.variableDeclaration("let", [t.variableDeclarator(k, v)]);

let transform_plugin: PluginObj = {
  visitor: {
    CallExpression(path) {
      path.node.arguments = path.node.arguments
        .map(arg => {
          if (arg.type == "SpreadElement" && arg.argument.type == "ArrayExpression") {
            return arg.argument.elements.map(el => el!);
          } else {
            return [arg];
          }
        })
        .flat();
    },
  },
};

export let translate = async (input: string, tree: Tree): Promise<Translation> => {
  let node = tree.topNode;
  assert(matches(node, terms.Top));
  global = {
    input,
    used_prelude: new Set(["Document"]),
    imports: new Set(),
  };

  let doc_body = translate_textbody(node.firstChild!);
  let doc = to_react(t.identifier("Document"), {}, [t.spreadElement(doc_body)]);

  let block = t.blockStatement([
    binding(
      t.objectPattern(
        Array.from(global.used_prelude).map(k =>
          t.objectProperty(t.identifier(k), t.identifier(k), true)
        )
      ),
      globals_arg
    ),
    binding(react_id, t.memberExpression(globals_arg, react_id)),
    binding(create_el, t.memberExpression(react_id, t.identifier("createElement"))),
    t.returnStatement(doc),
  ]);

  let fn = t.arrowFunctionExpression([globals_arg, imports_arg], block);
  let program = t.program([t.expressionStatement(fn)]);
  let result: any = transformFromAst(program, undefined, {
    plugins: [() => transform_plugin],
  });
  let js = result.code.slice(0, -1);

  return { js, imports: global.imports };
};

let translate_textbody = (node: SyntaxNode): Expression => {
  assert(matches(node, terms.TextBody));

  let tokens = node.getChildren(terms.TextToken);

  // Remove whitespace on the last line
  let last = _.last(tokens);
  if (last && matches(last.firstChild!, terms.Text)) {
    let s = text(last);
    if (s.match(/^[\s]*$/)) {
      tokens.pop();
    }
  }

  // Remove leading whitespace
  let line_starts = tokens
    .map((_t, i) => i)
    .filter(i => {
      let line_start = i > 0 && matches_newline(tokens[i - 1].firstChild!);
      return line_start && matches(tokens[i].firstChild!, terms.Text);
    });

  let min_leading_whitespace =
    line_starts.length > 0
      ? line_starts
          .map(i => {
            let s = text(tokens[i]);
            return s.match(/^( )*/)![0].length;
          })
          .reduce((a, b) => Math.min(a, b))
      : 0;

  let output: Either<Expression, Statement>[] = [];
  tokens.forEach((token, i) => {
    if (line_starts.includes(i)) {
      let stripped = text(token).slice(min_leading_whitespace);
      if (stripped.length > 0) {
        output.push(left(t.stringLiteral(stripped)));
      }
    } else if (matches_newline(token.firstChild!) && (i == 0 || i == tokens.length - 1)) {
      // pass
    } else {
      output.push(translate_token(token));
    }
  });

  let array: (Expression | SpreadElement)[] = [];
  let cur_array = array;
  output.forEach(result => {
    if (is_left(result)) {
      cur_array.push(result.value);
    } else {
      cur_array = [];
      let body = t.blockStatement([result.value, t.returnStatement(t.arrayExpression(cur_array))]);
      let fn = t.spreadElement(t.callExpression(t.arrowFunctionExpression([], body), []));
      array.push(fn);
    }
  });

  return t.arrayExpression(array);
};

type Either<L, R> = Left<L> | Right<R>;
interface Left<L> {
  type: "Left";
  value: L;
}
interface Right<R> {
  type: "Right";
  value: R;
}
let left = <L, R>(value: L): Either<L, R> => ({ type: "Left", value });
let right = <L, R>(value: R): Either<L, R> => ({ type: "Right", value });
let is_left = <L, R>(e: Either<L, R>): e is Left<L> => e.type == "Left";
let is_right = <L, R>(e: Either<L, R>): e is Right<R> => e.type == "Right";

let translate_token = (node: SyntaxNode): Either<Expression, Statement> => {
  assert(matches(node, terms.TextToken));

  let child = node.firstChild!;
  if (matches(child, terms.Command)) {
    return translate_command(child);
  } else if (matches(child, terms.Text)) {
    return left(t.stringLiteral(text(child)));
  } else if (matches(child, terms.Newline)) {
    return left(t.stringLiteral("\n"));
  } else if (matches(child, terms.Multinewline)) {
    return left(t.stringLiteral("\n\n"));
  } else {
    throw `Unhandled child type ${child.name}`;
  }
};

let translate_command = (node: SyntaxNode): Either<Expression, Statement> => {
  assert(matches(node, terms.Command));

  let sigil = text(node.getChild(terms.CommandSigil)!);
  let name = node.getChild(terms.CommandName)!;
  let named_args = node.getChildren(terms.CommandNamedArg);
  let anon_args = node.getChildren(terms.CommandAnonArg);

  if (sigil == "@" || sigil == "#") {
    let name_str = text(name);
    if (PRELUDE.has(name_str)) {
      global.used_prelude.add(name_str);
    }
    let name_js = INTRINSIC_ELEMENTS.has(name_str)
      ? t.stringLiteral(name_str)
      : t.identifier(name_str);

    let anon_args_exprs = anon_args.map(node => {
      let child = node.firstChild!;
      if (matches(child, terms.TextBody)) {
        return t.spreadElement(translate_textbody(node.firstChild!));
      } else if (matches(child, terms.VerbatimText)) {
        return t.stringLiteral(text(child));
      } else {
        throw `Unknown CommandAnonArg ${child.name}`;
      }
    });

    if (sigil == "@") {
      return left(to_react(name_js, {}, anon_args_exprs));
    } else {
      // sigil == "#"
      return left(t.callExpression(t.identifier(name_str), anon_args_exprs));
    }
  } else {
    // sigil == "%"
    let name_str = text(name);
    if (name_str == "import") {
      let import_path = text(anon_args[0].firstChild!);
      global.imports.add(import_path);
      let imports = anon_args.slice(1).map(arg => {
        let id = t.identifier(text(arg.firstChild!));
        return t.objectProperty(id, id, true);
      });
      return right(
        binding(
          t.objectPattern(imports),
          t.memberExpression(imports_arg, t.stringLiteral(import_path), true)
        )
      );
    } else {
      throw `Unknown %-command ${name_str}`;
    }
  }
};
