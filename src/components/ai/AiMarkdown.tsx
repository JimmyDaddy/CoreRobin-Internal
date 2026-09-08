import { Fragment, memo, useMemo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { decodeHTMLStrict } from "entities";
import "./AiMarkdown.css";

// Model output is presentation only: never turn HTML, images or model URLs
// into WebView DOM authority, network requests, navigation or native actions.
function renderTokens(tokens: Token[], depth = 0): ReactNode {
  if (depth > 32) return tokens.map((token) => token.raw).join("");
  return tokens.map((token, index) => {
    const nested = (children: Token[]) => renderTokens(children, depth + 1);
    let node: ReactNode;
    switch (token.type) {
      case "space": case "def": return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Tag = `h${Math.max(3, heading.depth)}` as "h3" | "h4" | "h5" | "h6";
        node = <Tag>{nested(heading.tokens)}</Tag>;
        break;
      }
      case "paragraph": node = <p>{nested((token as Tokens.Paragraph).tokens)}</p>; break;
      case "text": {
        const text = token as Tokens.Text;
        node = text.tokens ? nested(text.tokens) : text.escaped ? text.text : decodeHTMLStrict(text.text);
        break;
      }
      case "strong": node = <strong>{nested((token as Tokens.Strong).tokens)}</strong>; break;
      case "em": node = <em>{nested((token as Tokens.Em).tokens)}</em>; break;
      case "del": node = <del>{nested((token as Tokens.Del).tokens)}</del>; break;
      case "codespan": node = <code>{(token as Tokens.Codespan).text}</code>; break;
      case "code": node = <pre tabIndex={0}><code>{(token as Tokens.Code).text}</code></pre>; break;
      case "blockquote": node = <blockquote>{nested((token as Tokens.Blockquote).tokens)}</blockquote>; break;
      case "br": node = <br />; break;
      case "hr": node = <hr />; break;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => <li key={itemIndex}>{item.task && <input type="checkbox" checked={!!item.checked} disabled readOnly />}{nested(item.tokens)}</li>);
        node = list.ordered ? <ol start={Number(list.start) || 1}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        node = <div className="ai-markdown-table" tabIndex={0}><table><thead><tr>{table.header.map((cell, column) => <th key={column} style={{ textAlign: table.align[column] ?? undefined }}>{nested(cell.tokens)}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: table.align[column] ?? undefined }}>{nested(cell.tokens)}</td>)}</tr>)}</tbody></table></div>;
        break;
      }
      case "link": {
        const link = token as Tokens.Link;
        node = <span className="ai-markdown-link" title={link.href}>{nested(link.tokens)}</span>;
        break;
      }
      case "image": node = decodeHTMLStrict((token as Tokens.Image).text); break;
      case "escape": node = (token as Tokens.Escape).text; break;
      default: node = token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

export const AiMarkdown = memo(function AiMarkdown({ content }: { content: string }) {
  const rendered = useMemo(() => {
    try { return renderTokens(marked.lexer(content, { gfm: true, breaks: true })); }
    catch { return content; }
  }, [content]);
  return <div className="ai-markdown">{rendered}</div>;
});
