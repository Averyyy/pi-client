// biome-ignore-all lint/suspicious/noArrayIndexKey: Parsed Markdown nodes have no local component state.
import { type MarkedToken, marked } from "marked";
import { createElement, memo, type ReactNode } from "react";

export function safeLink(href: string): string | undefined {
	try {
		const url = new URL(href, "https://viewer.invalid/");
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? href : undefined;
	} catch {
		return undefined;
	}
}

function renderTokens(tokens: readonly MarkedToken[]): ReactNode[] {
	return tokens.map((token, key) => {
		const children = "tokens" in token && token.tokens ? renderTokens(token.tokens as MarkedToken[]) : undefined;
		switch (token.type) {
			case "space":
			case "def":
				return null;
			case "heading":
				return createElement(`h${token.depth}`, { key }, children);
			case "paragraph":
				return <p key={key}>{children}</p>;
			case "text":
				return <span key={key}>{children ?? token.text}</span>;
			case "escape":
				return token.text;
			case "strong":
				return <strong key={key}>{children}</strong>;
			case "em":
				return <em key={key}>{children}</em>;
			case "del":
				return <del key={key}>{children}</del>;
			case "br":
				return <br key={key} />;
			case "hr":
				return <hr key={key} />;
			case "blockquote":
				return <blockquote key={key}>{children}</blockquote>;
			case "codespan":
				return <code key={key}>{token.text}</code>;
			case "code":
				return (
					<div className="code-block" key={key}>
						{token.lang ? <div className="code-language">{token.lang}</div> : null}
						<pre>
							<code>{token.text}</code>
						</pre>
					</div>
				);
			case "link": {
				const href = safeLink(token.href);
				return href ? (
					<a href={href} title={token.title ?? undefined} target="_blank" rel="noreferrer noopener" key={key}>
						{children}
					</a>
				) : (
					<span key={key}>{children}</span>
				);
			}
			case "image":
				return (
					<span className="attachment" key={key}>
						图片 · {token.text || "附件"}
					</span>
				);
			case "html":
				return <span key={key}>{token.text}</span>;
			case "checkbox":
				return (
					<span className="task-checkbox" title={token.checked ? "已完成" : "未完成"} key={key}>
						{token.checked ? "☑" : "☐"}
					</span>
				);
			case "list": {
				const items = token.items.map((item, index) => (
					<li key={index}>{renderTokens(item.tokens as MarkedToken[])}</li>
				));
				return token.ordered ? (
					<ol key={key} start={Number(token.start)}>
						{items}
					</ol>
				) : (
					<ul key={key}>{items}</ul>
				);
			}
			case "list_item":
				return <li key={key}>{children}</li>;
			case "table":
				return (
					<div className="table-wrap" key={key}>
						<table>
							<thead>
								<tr>
									{token.header.map((cell, index) => (
										<th key={index} className={`align-${token.align[index] ?? "left"}`}>
											{renderTokens(cell.tokens as MarkedToken[])}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{token.rows.map((row, rowIndex) => (
									<tr key={rowIndex}>
										{row.map((cell, index) => (
											<td key={index} className={`align-${token.align[index] ?? "left"}`}>
												{renderTokens(cell.tokens as MarkedToken[])}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
		}
		return null;
	});
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return <div className="markdown">{renderTokens(marked.lexer(text, { gfm: true }) as MarkedToken[])}</div>;
});
