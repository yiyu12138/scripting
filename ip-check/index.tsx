import { Widget } from "scripting";

async function main() {
  // App 内运行只看预览，Widget.present 由 widget.tsx 在 env === "widget" 时调用
  await Widget.preview({ family: "systemSmall" });
}

main();
