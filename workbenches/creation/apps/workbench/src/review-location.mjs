// Keep a character map so a visible Markdown selection can bind to literal source.
function visibleCharacters(source) {
  let chars = source.split("").map((char, index) => ({ char, index }));
  const remove = (expression) => {
    const text = chars.map((item) => item.char).join("");
    const dropped = new Set();
    for (const match of text.matchAll(expression))
      for (let i = match.index; i < match.index + match[0].length; i++)
        dropped.add(i);
    chars = chars.filter((_, index) => !dropped.has(index));
  };
  const text = chars.map((item) => item.char).join("");
  const dropped = new Set();
  for (const match of text.matchAll(/!?\[([^\]]+)\]\([^\n)]+\)/g)) {
    const start = match.index + match[0].indexOf("[") + 1;
    for (
      let index = match.index;
      index < match.index + match[0].length;
      index++
    )
      if (index < start || index >= start + match[1].length) dropped.add(index);
  }
  chars = chars.filter((_, index) => !dropped.has(index));
  remove(/\*\*|__|`+|^#{1,6}\s+/gm);
  const collapsed = [];
  for (const item of chars) {
    const char = /\s/.test(item.char) ? " " : item.char;
    if (char === " " && collapsed.at(-1)?.char === " ") continue;
    collapsed.push({ ...item, char });
  }
  return collapsed;
}
export function visibleQuote(source) {
  return visibleCharacters(source)
    .map((item) => item.char)
    .join("")
    .trim();
}
export function sourceQuote(source, selected) {
  if (source.includes(selected)) return selected;
  const chars = visibleCharacters(source),
    text = chars.map((item) => item.char).join(""),
    query = visibleQuote(selected);
  const start = text.indexOf(query);
  if (!query || start < 0) return null;
  return source.slice(
    chars[start].index,
    chars[start + query.length - 1].index + 1,
  );
}
