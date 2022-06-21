import type { BabelFileResult, PluginObj } from "@babel/core";
import * as babel from "@babel/standalone";
import type {
  ExportDeclaration,
  Expression,
  ExpressionStatement,
  ImportDeclaration,
  ObjectProperty,
  Program,
  SourceLocation,
  SpreadElement,
  Statement,
} from "@babel/types";
import type { SyntaxNode, Tree } from "@lezer/common";
import { assert, unreachable } from "@nota-lang/nota-common";
import { Either, isLeft, isRight, left, right } from "@nota-lang/nota-common/dist/either.js";
import he from "he";
import indentString from "indent-string";
import _ from "lodash";
import type React from "react";

import type { Terms } from "../parse/extensions/nota.js";
import { jsTerms, mdTerms } from "../parse/mod.js";
import * as t from "./babel-polyfill.js";
//@ts-ignore
import COMPONENTS from "./components.js";
import { INTRINSIC_ELEMENTS } from "./intrinsic-elements.js";

export let babelPolyfill = t;

export let matches = (node: SyntaxNode, term: number): boolean => node.type.id == term;

let strLit = t.stringLiteral;

let anonArgsId = t.identifier("args");

let scopeStatements = (stmts: Statement[], expr: Expression): Expression => {
  if (stmts.length == 0) {
    return expr;
  } else {
    let body = t.blockStatement([...stmts, t.returnStatement(expr)]);
    let fn_call = t.callExpression(t.arrowFunctionExpression([], body), []);
    return fn_call;
  }
};

type MarkdownChildren = Either<SyntaxNode, string>[];

export class LineMap {
  lines: { start: number; end: number }[] = [];

  constructor(input: string) {
    let lineStart = 0;
    for (let i = 0; i < input.length; ++i) {
      if (input[i] == "\n") {
        this.lines.push({ start: lineStart, end: i });
        lineStart = i + 1;
      }
    }
    this.lines.push({ start: lineStart, end: input.length });
  }

  offsetToLocation(n: number): { line: number; column: number } {
    if (n < 0 || n > this.lines[this.lines.length - 1].end) {
      throw new Error(`Invalid offset: ${n}`);
    }

    let line = this.lines.findIndex(l => l.start <= n && n <= l.end);
    let column = n - this.lines[line].start;
    line += 1;
    return { line, column };
  }
}

export class Translator {
  input: string;
  lineMap: LineMap;
  imports: Set<ImportDeclaration> = new Set();
  exports: Set<ExportDeclaration> = new Set();

  constructor(input: string) {
    this.input = input;
    this.lineMap = new LineMap(this.input);
  }

  text(cursor: SyntaxNode): string {
    return this.input.slice(cursor.from, cursor.to);
  }

  private spanned<T>(jsNode: T, lezerNode: SyntaxNode): T {
    let nodeAny: any = jsNode;
    let loc: SourceLocation = {
      start: this.lineMap.offsetToLocation(lezerNode.from),
      end: this.lineMap.offsetToLocation(lezerNode.to),
    };
    return { ...nodeAny, loc };
  }

  private markdownChildren(node: SyntaxNode): MarkdownChildren {
    let children: MarkdownChildren = [];
    let pos = node.from;
    let child = node.firstChild;

    let pushStr = (from: number, to: number) => {
      children.push(right(this.input.slice(from, to)));
    };

    while (child) {
      if (child.from > pos) {
        pushStr(pos, child.from);
      }

      children.push(left(child));
      pos = child.to;
      child = child.nextSibling;
    }

    if (pos < node.to) {
      pushStr(pos, node.to);
    }

    return children;
  }

  translateMdBlockSequence(node: SyntaxNode, ignore: number[] = []): Expression {
    let child = node.firstChild;
    let array: (Expression | SpreadElement)[] = [];
    let curArray = array;
    while (child) {
      if (ignore.includes(child.type.id)) {
        child = child.nextSibling;
        continue;
      }

      let [expr, stmts] = this.translateMdBlock(child);
      if (stmts.length > 0) {
        let newArray: (Expression | SpreadElement)[] = [expr];
        let scopedExpr = scopeStatements(stmts, t.arrayExpression(newArray));
        curArray.push(t.spreadElement(scopedExpr));
        curArray = newArray;
      } else {
        curArray.push(expr);
      }
      child = child.nextSibling;
    }

    return t.arrayExpression(array);
  }

  translateMdDocument(node: SyntaxNode): Expression {
    assert(matches(node, mdTerms.Document));
    return this.translateMdBlockSequence(node, []);
  }

  translateMdInline(node: SyntaxNode): Expression {
    let type = node.type.id;
    let mdChildren = this.markdownChildren(node);
    let delimitedTypes: { [ty: number]: string } = {
      [mdTerms.StrongEmphasis]: "strong",
      [mdTerms.Emphasis]: "em",
      [mdTerms.InlineCode]: "code",
      [mdTerms.Strikethrough]: "s",
    };
    let expr: Expression;
    if (type in delimitedTypes) {
      let children = this.translateMdInlineSequence(mdChildren.slice(1, -1));
      expr = toReact(strLit(delimitedTypes[type]), [], children);
    } else {
      switch (type) {
        // Markdown builtins:
        case mdTerms.Link: {
          let linkMarkIndexes = mdChildren
            .map<[Either<SyntaxNode, string>, number]>((node, i) => [node, i])
            .filter(([node]) => isLeft(node) && node.value.type.id == mdTerms.LinkMark)
            .map(([_, i]) => i);
          let display = mdChildren.slice(linkMarkIndexes[0] + 1, linkMarkIndexes[1]);
          let url = node.getChild(mdTerms.URL)!;
          let children = this.translateMdInlineSequence(display);
          expr = toReact(strLit("a"), [[strLit("href"), strLit(this.text(url))]], children);
          break;
        }

        case mdTerms.MathMark:
        case mdTerms.QuoteMark: {
          expr = t.nullLiteral();
          break;
        }

        case mdTerms.Escape: {
          expr = strLit(this.text(node).slice(1));
          break;
        }

        case mdTerms.URL: {
          // remove < and >
          let url = this.text(node).slice(1, -1);
          expr = toReact(strLit("a"), [[strLit("href"), strLit(url)]], [strLit(url)]);
          break;
        }

        case mdTerms.Entity: {
          expr = strLit(he.decode(this.text(node)));
          break;
        }

        // Nota extensions:
        case mdTerms.MathInline: {
          let children = this.translateMdInlineSequence(this.markdownChildren(node));
          expr = toReact(t.identifier("$"), [], children);
          break;
        }

        case mdTerms.NotaInlineComponent: {
          expr = this.translateNotaComponent(node);
          break;
        }

        case mdTerms.NotaInterpolation: {
          expr = this.translateNotaInterpolation(node);
          break;
        }

        case mdTerms.Ref: {
          let nameNode = node.getChild(mdTerms.NotaCommandName)!;
          let nameExpr = this.translateNotaCommandName(nameNode);
          if (nameExpr.type == "Identifier") {
            nameExpr = strLit(nameExpr.name);
          }
          expr = toReact(t.identifier("Ref"), [], [nameExpr]);
          break;
        }

        case mdTerms.Comment: {
          expr = t.nullLiteral();
          break;
        }

        default: {
          throw `Inline element not yet implemented: ${node.name} (${this.text(node)})`;
        }
      }
    }

    return this.spanned(expr, node);
  }

  translateMdInlineSequence(sequence: MarkdownChildren): Expression[] {
    return sequence.map(child =>
      isLeft(child) ? this.translateMdInline(child.value) : strLit(child.value)
    );
  }

  translateMdBlock(node: SyntaxNode): [Expression, Statement[]] {
    let type = node.type.id;

    let mdChildren = this.markdownChildren(node);
    let expr: Expression;
    let stmts: Statement[] = [];
    switch (type) {
      case mdTerms.Paragraph: {
        let children = this.translateMdInlineSequence(mdChildren);
        expr = toReact(strLit("p"), [], children);
        break;
      }

      case mdTerms.ATXHeading1:
      case mdTerms.ATXHeading2:
      case mdTerms.ATXHeading3:
      case mdTerms.ATXHeading4:
      case mdTerms.ATXHeading5:
      case mdTerms.ATXHeading6: {
        let depth = type - mdTerms.ATXHeading1 + 1;
        // slice(1) for HeaderMark
        let children = this.translateMdInlineSequence(mdChildren.slice(1));
        expr = toReact(strLit(`h${depth}`), [], children);
        break;
      }

      case mdTerms.FencedCode: {
        let attributes: [Expression, Expression][] = [];
        let codeInfo = node.getChild(mdTerms.CodeInfo);
        if (codeInfo) {
          attributes.push([strLit("language"), t.identifier(this.text(codeInfo))]);
        }

        let codeText = node.getChild(mdTerms.CodeText)!;

        expr = toReact(t.identifier("Listing"), attributes, [strLit(this.text(codeText))]);
        break;
      }

      case mdTerms.Blockquote: {
        let [subexpr, substmts] = this.translateMdBlock(node.lastChild!);
        expr = toReact(strLit("blockquote"), [], [subexpr]);
        stmts = substmts;
        break;
      }

      case mdTerms.OrderedList:
      case mdTerms.BulletList: {
        let items = node.getChildren(mdTerms.ListItem).map(item => {
          let children = collectSiblings(item.firstChild);
          let exprs: Expression[] = [];
          // slice(1) for ItemMark
          children.slice(1).forEach(child => {
            let [child_expr, child_stmts] = this.translateMdBlock(child);
            exprs.push(child_expr);
            stmts = stmts.concat(child_stmts);
          });

          return toReact(strLit("li"), [], exprs);
        });
        let tag = type == mdTerms.OrderedList ? "ol" : "ul";
        expr = toReact(strLit(tag), [], items);
        break;
      }

      case mdTerms.NotaScript: {
        let child = node.getChild(jsTerms.NotaStmts)!;
        stmts = parse(this.replaceNotaCalls(child));
        stmts = stmts.filter(stmt => {
          if (stmt.type == "ImportDeclaration") {
            this.imports.add(stmt);
            return false;
          } else if (stmt.type == "ExportNamedDeclaration") {
            this.exports.add(stmt);
            return false;
          } else {
            return true;
          }
        });
        expr = t.nullLiteral();
        break;
      }

      case mdTerms.NotaBlockComponent: {
        expr = this.translateNotaComponent(node);
        break;
      }

      case mdTerms.MathBlock: {
        let template = node.getChild(jsTerms.NotaTemplateExternal)!.getChild(jsTerms.NotaTemplate)!;
        let children = this.translateNotaTemplate(template);
        expr = toReact(t.identifier("$$"), [], [t.spreadElement(children)]);
        break;
      }

      case mdTerms.Comment: {
        expr = t.nullLiteral();
        break;
      }

      default: {
        console.trace();
        throw new Error(`Block element not yet implemented: ${node.name} (${this.text(node)})`);
      }
    }

    return [this.spanned(expr, node), stmts];
  }

  translateNotaCommandName(node: SyntaxNode, terms: Terms = mdTerms): Expression {
    assert(matches(node, terms.NotaCommandName));

    let child;
    if ((child = node.getChild(terms.NotaCommandNameExpression))) {
      return parseExpr(this.replaceNotaCalls(child));
    } else if ((child = node.getChild(terms.NotaCommandNameInteger))) {
      return t.memberExpression(anonArgsId, t.numericLiteral(parseInt(this.text(child)) - 1));
    } else if ((child = node.getChild(terms.NotaCommandNameIdentifier))) {
      return t.identifier(this.text(node));
    } else {
      unreachable();
    }
  }

  translateNotaInterpolation(node: SyntaxNode): Expression {
    assert(matches(node, mdTerms.NotaInterpolation));

    let nameNode = node.getChild(mdTerms.NotaCommandName)!;
    let nameExpr = this.translateNotaCommandName(nameNode);

    let args = node.getChildren(mdTerms.NotaInlineContent).map(child => {
      let subchildren = this.markdownChildren(child).slice(1, -1);
      let exprs = this.translateMdInlineSequence(subchildren);
      return t.arrayExpression(exprs);
    });

    if (args.length > 0) {
      return t.callExpression(nameExpr, args);
    } else {
      return nameExpr;
    }
  }

  translateNotaComponent(node: SyntaxNode): Expression {
    assert(matches(node, mdTerms.NotaBlockComponent) || matches(node, mdTerms.NotaInlineComponent));

    let nameNode = node.getChild(mdTerms.NotaCommandName);
    let nameExpr: Expression | undefined;
    if (nameNode) {
      nameExpr = this.translateNotaCommandName(nameNode);
      if (nameExpr.type == "Identifier" && INTRINSIC_ELEMENTS.has(nameExpr.name)) {
        nameExpr = strLit(nameExpr.name);
      }
    }

    let attrExprs = [];
    let inlineAttrs = node.getChild(jsTerms.NotaInlineAttrs);
    if (inlineAttrs) {
      let properties = inlineAttrs
        .getChildren(jsTerms.Property)
        .map(child => this.replaceNotaCalls(child))
        .join(", ");
      attrExprs.push(parseExpr(`{${properties}}`));
    }

    let blockAttrs = node.getChildren(mdTerms.NotaBlockAttribute);
    let blockAttrKvs: ObjectProperty[] = [];
    blockAttrs.forEach(child => {
      let key = strLit(this.text(child.getChild(mdTerms.NotaAttributeKey)!));
      let valueNode = child.getChild(jsTerms.NotaExpr);
      let value = valueNode ? parseExpr(this.replaceNotaCalls(valueNode)) : t.nullLiteral();
      blockAttrKvs.push(t.objectProperty(key, value));
    });
    if (blockAttrKvs.length > 0) {
      attrExprs.push(t.objectExpression(blockAttrKvs));
    }

    let attrExpr =
      attrExprs.length > 1
        ? t.objectExpression(attrExprs.map(expr => t.spreadElement(expr)))
        : attrExprs.length == 1
        ? attrExprs[0]
        : t.objectExpression([]);

    let args: (Expression | SpreadElement)[] = [];

    let childrenNode = node.getChild(mdTerms.NotaInlineContent);
    if (childrenNode) {
      let subchildren = this.markdownChildren(childrenNode).filter(
        node => isRight(node) || node.value.type.id != mdTerms.NotaInlineContentMark
      );
      args = args.concat(this.translateMdInlineSequence(subchildren));
    }

    let subDoc = this.translateMdBlockSequence(node, [
      mdTerms.NotaCommandName,
      mdTerms.NotaBlockAttribute,
      mdTerms.NotaInlineContent,
      mdTerms["@"],
      jsTerms.NotaInlineAttrs,
    ]);
    if (subDoc.type != "ArrayExpression" || subDoc.elements.length > 0) {
      args.push(t.spreadElement(subDoc));
    }

    if (nameExpr) {
      return t.callExpression(createEl, [nameExpr, attrExpr, ...args]);
    } else {
      return t.arrayExpression(args);
    }
  }

  translateNotaTemplate(node: SyntaxNode): Expression {
    assert(matches(node, jsTerms.NotaTemplate));

    let children = collectSiblings(node.firstChild);
    let childExprs = children.map(child => {
      if (matches(child, jsTerms.NotaTemplateLiteral)) {
        return strLit(this.text(child));
      } else {
        assert(matches(child, jsTerms.NotaTemplateCommand));
        let nameNode = child.getChild(jsTerms.NotaCommandName)!;
        let nameExpr = this.translateNotaCommandName(nameNode, jsTerms);
        let args = child.getChildren(jsTerms.NotaCommandArg);
        if (args.length == 0) {
          return nameExpr;
        } else {
          return t.callExpression(
            nameExpr,
            args.map(arg => this.translateNotaTemplate(arg.getChild(jsTerms.NotaTemplate)!))
          );
        }
      }
    });
    return t.arrayExpression(childExprs);
  }

  replaceNotaCalls(node: SyntaxNode): string {
    let cursor = node.cursor();
    let replacements: [number, number, string][] = [];
    while (node.from <= cursor.from && cursor.to <= node.to) {
      let expr: Expression | undefined;
      if (matches(cursor.node, jsTerms.NotaMacro)) {
        let template = cursor.node.getChild(jsTerms.NotaTemplate)!;
        let args = t.identifier("args");
        expr = t.arrowFunctionExpression(
          [t.restElement(args)],
          this.translateNotaTemplate(template)
        );
      } else if (matches(cursor.node, mdTerms.Document)) {
        let component = cursor.node
          .getChild(mdTerms.Paragraph)!
          .getChild(mdTerms.NotaInlineComponent)!;
        expr = this.translateNotaComponent(component);
      }

      if (expr) {
        let result = babel.transformFromAst(
          t.program([t.expressionStatement(expr)]),
          undefined,
          {}
        ) as any as BabelFileResult;
        let code = result.code!.slice(0, -1);
        replacements.push([cursor.from - node.from, cursor.to - node.from, code]);

        if (!cursor.next(false)) {
          break;
        }
      } else if (!cursor.next()) {
        break;
      }
    }

    let code = this.text(node);
    replacements = _.sortBy(replacements, [0]);
    let expanded = "";
    let i = 0;
    replacements.forEach(([from, to, expr]) => {
      expanded += code.slice(i, from);
      expanded += expr;
      i = to;
    });
    expanded += code.slice(i);

    return expanded;
  }
}

let fragment = t.identifier("Fragment");
let createEl = t.identifier("el");
let argumentsId = t.identifier("args");

let toReact = (
  name: Expression,
  props: ([Expression, Expression] | SpreadElement)[],
  children: (Expression | SpreadElement)[]
): Expression => {
  let args: (Expression | SpreadElement)[] = [
    name,
    t.objectExpression(props.map(p => (p instanceof Array ? t.objectProperty(p[0], p[1]) : p))),
  ];
  return t.callExpression(createEl, args.concat(children));
};

export type TranslatedFunction = (
  _symbols: { [key: string]: any },
  _imports: { [path: string]: any }
) => React.ReactElement;

export interface Translation {
  js: string;
  imports: Set<string>;
}

export let optimizePlugin = (): PluginObj => ({
  visitor: {
    ArrayExpression(path) {
      // [...[e1, e2]] => [e1, e2]
      path.node.elements = path.node.elements
        .map(el => {
          if (el && el.type == "SpreadElement" && el.argument.type == "ArrayExpression") {
            return el.argument.elements;
          } else {
            return [el];
          }
        })
        .flat();
    },

    ObjectExpression(path) {
      let props = path.node.properties;
      /// {...e} => e
      if (props.length == 1 && props[0].type == "SpreadElement") {
        path.replaceWith(props[0].argument);
      }
    },

    CallExpression(path) {
      let expr = path.node;
      if (
        expr.arguments.length == 0 &&
        expr.arguments.length == 0 &&
        expr.callee.type == "ArrowFunctionExpression" &&
        expr.callee.body.type == "BlockStatement" &&
        expr.callee.body.body.length == 1 &&
        expr.callee.body.body[0].type == "ReturnStatement" &&
        expr.callee.body.body[0].argument
      ) {
        // `(() => { return e; })()` => `e`
        path.replaceWith(expr.callee.body.body[0].argument);
        path.visit();
      } else {
        path.node.arguments = path.node.arguments
          .map(arg => {
            // f(...[x, y]) => f(x, y)
            if (arg.type == "SpreadElement" && arg.argument.type == "ArrayExpression") {
              return arg.argument.elements.map(el => el!);
            } else {
              return [arg];
            }
          })
          .flat();
      }
    },
  },
});

let parse = (code: string): Statement[] => {
  let result = babel.transform(code, {
    ast: true,
  }) as any as BabelFileResult;
  return result.ast!.program.body;
};

export let parseExpr = (code: string): Expression => {
  let s = parse(`(${code});`)[0] as ExpressionStatement;
  return s.expression;
};

export let lambda = (body: Expression) =>
  t.arrowFunctionExpression([t.restElement(argumentsId)], body);

export let translateAst = (input: string, tree: Tree): Program => {
  let node = tree.topNode;
  let translator = new Translator(input);

  let docBody = translator.translateMdDocument(node);
  let docProps = t.identifier("docProps");
  let doc = toReact(
    t.identifier("Document"),
    [t.spreadElement(docProps)],
    [t.spreadElement(docBody)]
  );

  let prelude: { [k: string]: string } = COMPONENTS;

  let usedPrelude: Set<string> = new Set();
  t.traverse(doc, node => {
    if (node.type == "Identifier" && node.name in prelude) {
      usedPrelude.add(node.name);
    }
  });

  let preludeImports: { [k: string]: string[] } = {};
  for (let k of usedPrelude) {
    let path = prelude[k];
    if (!(path in preludeImports)) {
      preludeImports[path] = [];
    }
    preludeImports[path].push(k);
  }

  let createElLong = t.identifier("createElement");
  let observer = t.identifier("observer");

  let program: Statement[] = [
    t.importDeclaration(
      [t.importSpecifier(createEl, createElLong), t.importSpecifier(fragment, fragment)],
      strLit("react")
    ),
    t.importDeclaration([t.importSpecifier(observer, observer)], strLit("mobx-react")),
    t.importDeclaration(
      Object.keys(preludeImports).map(mod =>
        t.importSpecifier(t.identifier(mod), t.identifier(mod))
      ),
      strLit("@nota-lang/nota-components")
    ),
    ..._.toPairs(preludeImports).map(([mod, ks]) =>
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.objectPattern(ks.map(k => t.objectProperty(t.identifier(k), t.identifier(k), true))),
          t.identifier(mod)
        ),
      ])
    ),
    // ..._.toPairs(preludeImports).map(([path, ks]) =>
    //   t.importDeclaration(
    //     ks.map(k => t.importSpecifier(t.identifier(k), t.identifier(k))),
    //     strLit(path)
    //   ),
    // ),
    ...Array.from(translator.imports),
    ...Array.from(translator.exports),
    t.exportDefaultDeclaration(
      t.callExpression(observer, [t.arrowFunctionExpression([docProps], doc)])
    ),
  ];

  return t.program(program);
};

export let treeToString = (tree: Tree, contents: string): string => {
  let depth = (node: any): number => (node.parent ? 1 + depth(node.parent) : 0);
  let cursor = tree.cursor();
  let output = "";
  do {
    let subInput = contents.slice(cursor.from, cursor.to);
    if (subInput.length > 30) {
      subInput = subInput.slice(0, 12) + "..." + subInput.slice(-12);
    }
    subInput = subInput.replace("\n", "\\n");
    output += indentString(`${cursor.name}: "${subInput}"`, 2 * depth(cursor.node)) + "\n";
  } while (cursor.next());

  return output;
};

export let printTree = (tree: Tree, contents: string) => {
  console.log(treeToString(tree, contents));
};

export interface TranslateOptions {
  input: string;
  tree: Tree;
  sourceRoot?: string;
  filenameRelative?: string;
}

export let translate = ({
  input,
  tree,
  sourceRoot,
  filenameRelative,
}: TranslateOptions): BabelFileResult => {
  // printTree(tree, input);
  let program = translateAst(input, tree);
  return babel.transformFromAst(program, undefined, {
    sourceRoot,
    filenameRelative,
    sourceMaps: sourceRoot && filenameRelative ? "both" : undefined,
    plugins: [optimizePlugin],
  }) as any;
};

let collectSiblings = (arg: SyntaxNode | null): SyntaxNode[] => {
  let args = [];
  while (arg != null) {
    args.push(arg);
    arg = arg.nextSibling;
  }
  return args;
};
