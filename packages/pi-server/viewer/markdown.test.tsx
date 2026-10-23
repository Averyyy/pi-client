import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, safeLink } from "./markdown.tsx";

describe("readonly markdown", () => {
	it("renders formatting while leaving executable HTML and links inert", () => {
		const html = renderToStaticMarkup(
			<Markdown
				text={
					"**说明**\n\n<script>alert(1)</script>\n\n[执行](javascript:alert%281%29)\n\n![私有图片](https://external.invalid/track.png)"
				}
			/>,
		);
		expect(html).toContain("<strong><span>说明</span></strong>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain("<img");
		expect(html).not.toContain('src="https://external.invalid');
	});

	it("handles malformed links as text and permits ordinary source links", () => {
		expect(safeLink("http://[")).toBeUndefined();
		expect(safeLink("data:text/html,hello")).toBeUndefined();
		expect(safeLink("https://example.com/docs")).toBe("https://example.com/docs");
		expect(() => renderToStaticMarkup(<Markdown text="[链接](http://[)" />)).not.toThrow();
	});
});
