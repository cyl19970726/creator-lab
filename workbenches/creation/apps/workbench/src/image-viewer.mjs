export function imageLayout(
  width,
  height,
  viewportWidth,
  viewportHeight,
  scale = "fit",
) {
  const zoom =
    scale === "fit"
      ? Math.min(viewportWidth / width, viewportHeight / height, 1)
      : Math.max(0.1, Math.min(4, Number(scale)));
  return { scale: zoom, width: width * zoom, height: height * zoom };
}

export function createImageViewer(dialog) {
  const viewport = dialog.querySelector(".image-viewport");
  const canvas = dialog.querySelector(".image-canvas");
  const img = dialog.querySelector("img");
  const output = dialog.querySelector("[data-image-scale]");
  let mode = "fit",
    scale = 1,
    drag = null;
  function resize(preserveCenter = false) {
    if (!img.naturalWidth || !dialog.open) return;
    const center = {
      x:
        (viewport.scrollLeft + viewport.clientWidth / 2) /
        Math.max(canvas.clientWidth, 1),
      y:
        (viewport.scrollTop + viewport.clientHeight / 2) /
        Math.max(canvas.clientHeight, 1),
    };
    const next = imageLayout(
      img.naturalWidth,
      img.naturalHeight,
      viewport.clientWidth,
      viewport.clientHeight,
      mode,
    );
    scale = next.scale;
    img.style.width = `${next.width}px`;
    img.style.height = `${next.height}px`;
    canvas.style.width = `${Math.max(next.width, viewport.clientWidth)}px`;
    canvas.style.height = `${Math.max(next.height, viewport.clientHeight)}px`;
    output.textContent = `${Math.round(scale * 100)}%`;
    viewport.dataset.expanded = mode === "fit" ? "false" : "true";
    dialog
      .querySelector("[data-image-fit]")
      .setAttribute("aria-pressed", String(mode === "fit"));
    dialog
      .querySelector("[data-image-original]")
      .setAttribute("aria-pressed", String(mode === 1));
    viewport.scrollLeft = preserveCenter
      ? center.x * canvas.clientWidth - viewport.clientWidth / 2
      : 0;
    viewport.scrollTop = preserveCenter
      ? center.y * canvas.clientHeight - viewport.clientHeight / 2
      : 0;
  }
  dialog.querySelector("[data-image-fit]").onclick = () => {
    mode = "fit";
    resize();
  };
  dialog.querySelector("[data-image-original]").onclick = () => {
    mode = 1;
    resize();
  };
  for (const button of dialog.querySelectorAll("[data-image-zoom]")) {
    button.onclick = () => {
      mode = Math.max(
        0.1,
        Math.min(4, scale + Number(button.dataset.imageZoom)),
      );
      resize(true);
    };
  }
  img.onload = () => resize();
  img.onerror = () => {
    output.textContent = "图片读取失败，请重开或查看原图";
  };
  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || mode === "fit")
      return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  });
  const stopDrag = () => {
    drag = null;
  };
  viewport.addEventListener("pointerup", stopDrag);
  viewport.addEventListener("pointercancel", stopDrag);
  viewport.addEventListener("lostpointercapture", stopDrag);
  new ResizeObserver(() => resize(true)).observe(viewport);
  dialog.addEventListener("close", stopDrag);
  return function openImage(src, alt = "图片详情") {
    mode = "fit";
    img.alt = alt;
    img.src = src;
    dialog.querySelector("[data-image-source]").href = src;
    output.textContent = "加载中…";
    if (!dialog.open) dialog.showModal();
    resize();
  };
}
