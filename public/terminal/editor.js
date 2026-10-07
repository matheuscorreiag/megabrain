// The Files editor: CodeMirror 6, loaded the first time a file is opened (its
// packages come from node_modules through the import map in index.html).
// Highlighting follows the file's name, or its #! line; each language loads
// when first needed. Colors: the "editor" section of style.css.
//
//   const editor = createEditor(parent, { onSave });
//   editor.open(text, name);  editor.text;  editor.focus();

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { LanguageDescription, syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { tagHighlighter, tags as t } from '@lezer/highlight';

// Token classes, colored in style.css. The most specific tag wins.
const highlighter = tagHighlighter([
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string), t.monospace], class: 'tok-string' },
  { tag: [t.regexp, t.escape, t.url], class: 'tok-string2' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.variableName)], class: 'tok-number' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tok-function' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], class: 'tok-type' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.attributeName, class: 'tok-attribute' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: [t.operator, t.punctuation], class: 'tok-punctuation' },
  { tag: t.heading, class: 'tok-heading' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.inserted, class: 'tok-inserted' },
  { tag: t.deleted, class: 'tok-deleted' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

// Names language-data doesn't know.
const EXTRA = [
  [/\.(brs|bs)$/i, 'VB.NET'], // BrightScript (Roku): the closest grammar there is
  [/\.(plist)$/i, 'XML'],
  [/\.(webmanifest|jsonl)$/i, 'JSON'],
  [/^\.(bash|zsh)(rc|env|_profile)$|^\.z?profile$|^\.env(rc|\..*)?$/, 'Shell'],
];

function describe(name, text) {
  const extra = EXTRA.find(([re]) => re.test(name));
  if (extra) return LanguageDescription.matchLanguageName(languages, extra[1], false);
  const byName = LanguageDescription.matchFilename(languages, name);
  if (byName) return byName;
  // #!/usr/bin/env node, #!/bin/zsh, #!/usr/bin/python3 …
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  if (!shebang) return null;
  const program = (shebang[1].endsWith('/env') ? shebang[2] || '' : shebang[1]).split('/').pop().replace(/[\d.]+$/, '');
  return LanguageDescription.matchLanguageName(languages, program, false);
}

// Just the language (highlighting, indentation): not the extras some bring,
// like closing tags or completions — typing stays exactly what was typed.
async function loadLanguage(desc) {
  if (desc.name === 'Markdown') {
    const { markdown, markdownLanguage } = await import('@codemirror/lang-markdown');
    return markdown({ base: markdownLanguage, codeLanguages: languages }).language; // with its code blocks
  }
  return (await desc.load()).language;
}

export function createEditor(parent, { onSave }) {
  const language = new Compartment();
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlighter),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.darkTheme.of(true),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSave();
          return true;
        },
      },
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    language.of([]),
  ];
  const view = new EditorView({ parent });
  let opened = 0;

  return {
    get text() {
      return view.state.sliceDoc(); // with the file's own line endings
    },
    focus: () => view.focus(),
    open(text, name) {
      const n = ++opened;
      // Keep Windows line endings as they are, so saving doesn't rewrite them.
      const crlf = text.includes('\r\n') ? [EditorState.lineSeparator.of('\r\n')] : [];
      view.setState(EditorState.create({ doc: text, extensions: [extensions, crlf] }));
      view.scrollDOM.scrollTo(0, 0);
      const desc = describe(name, text);
      if (!desc) return;
      loadLanguage(desc)
        .then((lang) => n === opened && view.dispatch({ effects: language.reconfigure(lang) }))
        .catch((err) => console.warn('editor: language', desc.name, err));
    },
  };
}
