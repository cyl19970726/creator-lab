// Local-only browser contract fixture. It never calls a social platform or uploads remotely.
import http from "node:http";
import fs from "node:fs";
export function startFixture({ port = 4347, video, cover }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/video" || url.pathname === "/cover") {
      const file = url.pathname === "/video" ? video : cover,
        size = fs.statSync(file).size;
      const match = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = match ? Number(match[1]) : 0,
        end =
          match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      res.writeHead(match ? 206 : 200, {
        "Content-Type": url.pathname === "/video" ? "video/mp4" : "image/png",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    const parts = url.pathname.split("/"),
      platform = parts[1],
      mode = parts[2];
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(`<!doctype html><html><head><style>body{font:20px sans-serif;background:#f6f8f7;color:#143a30;margin:30px}video{height:480px;display:block}label{display:block;margin:8px}#editor{border:1px solid #ccc;min-height:60px}img{height:120px}button{padding:12px}</style></head><body>
  <h1>发布管线 · 本地模拟（不联网发布）</h1><p>Token经济猫</p><p>${platform}-fixture-id</p>
  ${
    mode === "editor"
      ? `<input id="videoInput" type="file" accept="video/mp4"><span id="ready" hidden>上传完成</span><video controls></video><input id="title"><div id="editor" contenteditable="true"></div><input id="coverInput" type="file" accept="image/png"><img id="coverImage"><label><input type="checkbox" id="coverOK" disabled>封面已载入</label>${["ai", "visibility", "publication", "location", "titleAccepted"].map((k) => `<label><input id="${k}" type="checkbox" checked>${k}</label>`).join("")}<button id="publish">发布</button><script>
  const v=document.querySelector('video');videoInput.onchange=()=>{v.src=URL.createObjectURL(videoInput.files[0]);v.onloadedmetadata=()=>{document.querySelector('#ready').hidden=false;};};
  coverInput.onchange=()=>{coverImage.src=URL.createObjectURL(coverInput.files[0]);coverImage.onload=()=>coverOK.checked=true;};
  publish.onclick=()=>{localStorage.setItem('${platform}-receipt',JSON.stringify({title:document.querySelector('#title').value,body:editor.innerText,at:new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,16),duration:v.duration}));location.href='/${platform}/list';};</script>`
      : ""
  }
  ${mode === "list" ? `<article class="receipt"></article><script>const r=JSON.parse(localStorage.getItem('${platform}-receipt')||'null');if(r){const t=Math.round(r.duration);document.querySelector('.receipt').textContent=r.title+' '+r.body+' '+String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0')+' '+r.at+' 审核中';}</script>` : ""}</body></html>`);
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const video = process.argv[2],
    cover = process.argv[3];
  await startFixture({ video, cover });
  console.log("Local fixture http://127.0.0.1:4347");
}
