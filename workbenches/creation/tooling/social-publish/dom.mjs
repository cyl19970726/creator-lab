// Enumerate live DOM, including closed shadow roots and iframe documents. Never persist backend IDs.
export async function makeDOM(h) {
  async function roots() {
    const { root } = await h.cdp("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const out = [];
    function walk(n) {
      if (n.nodeType === 9 || n.nodeType === 11) out.push(n.backendNodeId);
      for (const c of n.children || []) walk(c);
      for (const c of n.shadowRoots || []) walk(c);
      if (n.contentDocument) walk(n.contentDocument);
    }
    walk(root);
    return out;
  }
  async function call(id, fn, args = []) {
    const { object } = await h.cdp("DOM.resolveNode", { backendNodeId: id });
    const r = await h.cdp("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async function find(spec) {
    let found = [];
    for (const id of await roots()) {
      const { object } = await h.cdp("DOM.resolveNode", { backendNodeId: id });
      const result = await h.cdp("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(spec){
    const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
    let a=[...this.querySelectorAll(spec.selector||'*')].filter(e=>(spec.hidden||visible(e)));
    if(spec.text!==undefined){const n=s=>s.replace(/\\s+/g,'').trim();a=a.filter(e=>n(e.textContent)===n(spec.text));a=a.filter(e=>!a.some(x=>x!==e&&e.contains(x)));}
    if(spec.contains!==undefined){a=a.filter(e=>e.textContent.includes(spec.contains));a=a.filter(e=>!a.some(x=>x!==e&&e.contains(x)));}
    return a;
   }`,
        arguments: [{ value: spec }],
        returnByValue: false,
      });
      if (!result.result.objectId) continue;
      const props = await h.cdp("Runtime.getProperties", {
        objectId: result.result.objectId,
        ownProperties: true,
      });
      for (const p of props.result || [])
        if (/^\d+$/.test(p.name) && p.value?.objectId) {
          const { node } = await h.cdp("DOM.describeNode", {
            objectId: p.value.objectId,
          });
          found.push(node.backendNodeId);
        }
    }
    return [...new Set(found)];
  }
  async function one(spec) {
    const a = await find(spec);
    if (a.length !== 1)
      throw Error(
        `页面元素应唯一，实际 ${a.length} 个：${JSON.stringify(spec)}`,
      );
    return a[0];
  }
  async function click(spec) {
    const id = await one(spec);
    await call(id, 'function(){this.scrollIntoView({block:"center"})}');
    const point = await call(
      id,
      "function(){let r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}",
    );
    await h.click(point);
    return id;
  }
  async function fill(spec, value) {
    const id = await one(spec);
    await call(
      id,
      `function(){this.scrollIntoView({block:'center'});this.focus();if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r)}else{this.select()}}`,
    );
    await h.typeText(value);
    return id;
  }
  async function read(spec) {
    return call(
      await one(spec),
      "function(){return this.isContentEditable?this.innerText:this.value??this.textContent}",
    );
  }
  async function append(spec, value) {
    await call(
      await one(spec),
      `function(){this.focus();const r=document.createRange();r.selectNodeContents(this);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)}`,
    );
    await h.typeText(value);
  }
  return { find, one, click, fill, read, append, call };
}
