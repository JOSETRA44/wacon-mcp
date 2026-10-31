/**
 * The composer's line editor as pure functions over { text, cursor }.
 * Cursor positions are code-point indexes, so an emoji is one step, not two
 * UTF-16 halves (which would let the cursor land inside it and corrupt it).
 */
export interface EditorState {
  text: string;
  cursor: number;
}

const chars = (s: string) => Array.from(s);
const join = (a: string[]) => a.join("");

export const fromText = (text: string): EditorState => ({ text, cursor: chars(text).length });

export function insert(s: EditorState, input: string): EditorState {
  const a = chars(s.text);
  const ins = chars(input.replace(/\r\n?/g, "\n"));
  return { text: join([...a.slice(0, s.cursor), ...ins, ...a.slice(s.cursor)]), cursor: s.cursor + ins.length };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const a = chars(s.text);
  a.splice(s.cursor - 1, 1);
  return { text: join(a), cursor: s.cursor - 1 };
}

export function del(s: EditorState): EditorState {
  const a = chars(s.text);
  if (s.cursor >= a.length) return s;
  a.splice(s.cursor, 1);
  return { text: join(a), cursor: s.cursor };
}

export const left = (s: EditorState): EditorState => ({ ...s, cursor: Math.max(0, s.cursor - 1) });
export const right = (s: EditorState): EditorState => ({ ...s, cursor: Math.min(chars(s.text).length, s.cursor + 1) });

/** Home/End act on the current line of a multi-line message. */
export function home(s: EditorState): EditorState {
  const a = chars(s.text);
  let i = s.cursor;
  while (i > 0 && a[i - 1] !== "\n") i--;
  return { ...s, cursor: i };
}
export function end(s: EditorState): EditorState {
  const a = chars(s.text);
  let i = s.cursor;
  while (i < a.length && a[i] !== "\n") i++;
  return { ...s, cursor: i };
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

export function wordLeft(s: EditorState): EditorState {
  const a = chars(s.text);
  let i = s.cursor;
  while (i > 0 && !isWord(a[i - 1])) i--;
  while (i > 0 && isWord(a[i - 1])) i--;
  return { ...s, cursor: i };
}
export function wordRight(s: EditorState): EditorState {
  const a = chars(s.text);
  let i = s.cursor;
  while (i < a.length && !isWord(a[i])) i++;
  while (i < a.length && isWord(a[i])) i++;
  return { ...s, cursor: i };
}

/** Ctrl+W / Ctrl+Backspace. */
export function deleteWordBack(s: EditorState): EditorState {
  const target = wordLeft(s).cursor;
  const a = chars(s.text);
  return { text: join([...a.slice(0, target), ...a.slice(s.cursor)]), cursor: target };
}

/** Ctrl+U: delete to the start of the line. */
export function deleteToLineStart(s: EditorState): EditorState {
  const target = home(s).cursor;
  const a = chars(s.text);
  return { text: join([...a.slice(0, target), ...a.slice(s.cursor)]), cursor: target };
}

/** Split for rendering: before cursor, the char under it, after it. */
export function splitAtCursor(s: EditorState): [string, string, string] {
  const a = chars(s.text);
  return [join(a.slice(0, s.cursor)), a[s.cursor] ?? "", join(a.slice(s.cursor + 1))];
}
