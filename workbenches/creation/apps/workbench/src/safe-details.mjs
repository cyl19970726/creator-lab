// A small Markdown block extension, not general HTML enablement.
export function safeDetails(md) {
  md.block.ruler.before(
    "html_block",
    "safe_details",
    (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false;
      const line = state.src
        .slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
        .trim();
      if (/^<!--/.test(line)) {
        let next = start;
        while (
          next < end &&
          !state.src
            .slice(state.bMarks[next], state.eMarks[next])
            .includes("-->")
        )
          next++;
        if (next === end) return false;
        if (silent) return true;
        state.line = next + 1;
        return true;
      }
      const open = line.match(
        /^<details(?:\s+(open))?>\s*(?:<summary>(.*?)<\/summary>)?$/i,
      );
      const summary = line.match(/^<summary>(.*?)<\/summary>$/i);
      const close = /^<\/details>$/i.test(line);
      if (!open && !summary && !close) return false;
      if (silent) return true;
      const level = state.env.safeDetailsLevel || 0;
      if ((close || summary) && level === 0) return false;
      if (open) {
        const t = state.push("details_open", "details", 1);
        t.block = true;
        if (open[1]) t.attrSet("open", "");
        state.env.safeDetailsLevel = level + 1;
      }
      const label = open?.[2] ?? summary?.[1];
      if (label !== undefined) {
        state.push("summary_open", "summary", 1);
        const t = state.push("inline", "", 0);
        t.content = label;
        t.children = [];
        state.push("summary_close", "summary", -1);
      }
      if (close) {
        state.push("details_close", "details", -1);
        state.env.safeDetailsLevel = level - 1;
      }
      state.line = start + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote"] },
  );
}
