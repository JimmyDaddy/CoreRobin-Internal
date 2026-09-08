/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AiMarkdown } from "./AiMarkdown";

afterEach(cleanup);
it("decodes text entities without changing code or activating encoded HTML", () => {
  const { container } = render(<AiMarkdown content={'A &amp; B &copy; &#x4e2d; &lt;img src=x&gt;\n\n`&amp;`'} />);
  expect(container.querySelector("p")?.textContent).toBe("A & B © 中 <img src=x>");
  expect(container.querySelector("code")?.textContent).toBe("&amp;");
  expect(container.querySelector("img")).toBeNull();
});
it("renders Chinese headings, emphasis, nested lists and inline code", () => {
  const { container } = render(<AiMarkdown content={'### 总结\n\n**磁盘**是重点，释放 **2.5 GB**。\n\n- 用户缓存\n  - `_cache` 10.5 GB\n- *日志*'} />);
  expect(screen.getByRole("heading", { name: "总结" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("磁盘");
  expect(container.querySelector("ul ul code")?.textContent).toBe("_cache");
  expect(container.querySelector("em")?.textContent).toBe("日志");
});
it("renders GFM tables, ordered lists, quotes and fenced code", () => {
  const { container } = render(<AiMarkdown content={'| 项目 | 大小 |\n| --- | ---: |\n| 缓存 | 2 GB |\n\n3. 第三项\n\n> 提示\n\n```sh\necho "<hello>"\n```'} />);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(container.querySelector("ol")?.start).toBe(3);
  expect(container.querySelector("blockquote")?.textContent).toContain("提示");
  expect(container.querySelector("pre code")?.textContent).toBe('echo "<hello>"');
});
it("keeps HTML, images, links and action-like text inert", () => {
  const { container } = render(<AiMarkdown content={'<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[打开](javascript:alert) [文件](file:///tmp/x) [站点](https://example.com) ![图片](https://example.com/pixel.png)\n\n```json\n{"action":"delete"}\n```'} />);
  expect(container.querySelector("img, script, a, iframe, button, form")).toBeNull();
  expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(container.textContent).toContain('"action":"delete"');
  expect(container.textContent).toContain("图片");
});
it("handles streaming incomplete syntax and completes it on the next chunk", () => {
  const { container, rerender } = render(<AiMarkdown content={"### 总结\n\n**磁盘"} />);
  expect(container.textContent).toContain("磁盘");
  rerender(<AiMarkdown content={"### 总结\n\n**磁盘**\n\n```text\npartial"} />);
  expect(container.querySelector("strong")?.textContent).toBe("磁盘");
  expect(container.querySelector("pre")?.textContent).toBe("partial");
});
