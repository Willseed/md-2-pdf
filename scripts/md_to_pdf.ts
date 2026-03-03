#!/usr/bin/env node

interface CliArgs {
  input: string;
  output: string;
  help: boolean;
}

interface FsModule {
  createWriteStream(filePath: string): unknown;
  existsSync(filePath: string): boolean;
}

interface FsPromisesModule {
  readFile(filePath: string, encoding: string): Promise<string>;
  mkdir(dirPath: string, options: { recursive: boolean }): Promise<void>;
}

interface PathModule {
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
  dirname(pathValue: string): string;
  basename(pathValue: string, suffix?: string): string;
  extname(pathValue: string): string;
}

interface StreamPromisesModule {
  finished(stream: unknown): Promise<void>;
}

interface PdfTextOptions {
  indent?: number;
  continued?: boolean;
  width?: number;
  link?: string;
  goTo?: string;
  destination?: string;
}

interface PdfPage {
  margins: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
}

interface PdfDocument {
  x: number;
  y: number;
  page: PdfPage;
  addPage(): PdfDocument;
  pipe(stream: unknown): void;
  moveDown(lines?: number): PdfDocument;
  font(name: string): PdfDocument;
  fontSize(size: number): PdfDocument;
  text(content: string, options?: PdfTextOptions): PdfDocument;
  text(content: string, x: number, y: number, options?: PdfTextOptions): PdfDocument;
  heightOfString(content: string, options?: PdfTextOptions): number;
  rect(x: number, y: number, width: number, height: number): PdfDocument;
  moveTo(x: number, y: number): PdfDocument;
  lineTo(x: number, y: number): PdfDocument;
  strokeColor(color: string): PdfDocument;
  stroke(): PdfDocument;
  fillColor(color: string): PdfDocument;
  end(): void;
}

type PdfDocumentFactory = new (options: { size: string; margin: number }) => PdfDocument;

const fs = require("fs") as FsModule;
const fsp = require("fs/promises") as FsPromisesModule;
const path = require("path") as PathModule;
const streamPromises = require("stream/promises") as StreamPromisesModule;
const PDFDocument = require("pdfkit") as PdfDocumentFactory;

const HELP_TEXT =
  "Usage: npm run convert -- --input <file.md> [--output <file.pdf>]\n" +
  "Options:\n" +
  "  -i, --input   Input markdown file path (required)\n" +
  "  -o, --output  Output pdf file path (optional)\n" +
  "  -h, --help    Show this help message";
const CJK_CHARACTER_REGEX = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const INLINE_TOKEN_REGEX =
  /!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\(([^)]+)\)|\[\^([^\]]+)\]|<(https?:\/\/[^>\s]+)>/g;
const TABLE_SEPARATOR_CELL_REGEX = /^:?-{3,}:?$/;
const TABLE_CELL_PADDING = 4;
const BIG_MACHINE_PALETTE = {
  primary: "#BD2A2E",
  text: "#3B3936",
  light: "#B2BEBF",
  muted: "#889C9B",
  accent: "#486966",
} as const;
const RENDER_THEME_COLORS = {
  heading: BIG_MACHINE_PALETTE.primary,
  bodyText: BIG_MACHINE_PALETTE.text,
  tableBorder: BIG_MACHINE_PALETTE.light,
  divider: BIG_MACHINE_PALETTE.muted,
  blockQuoteText: BIG_MACHINE_PALETTE.accent,
} as const;

interface InlineSegment {
  text: string;
  link?: string;
  goTo?: string;
}

interface InlineRenderOptions {
  defaultFont: string;
  fontSize: number;
  cjkFontPath: string | null;
  indent?: number;
  width?: number;
  x?: number;
  y?: number;
  destination?: string;
}

function printHelp(): void {
  console.log(HELP_TEXT);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { input: "", output: "", help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--input" || token === "-i") {
      args.input = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--output" || token === "-o") {
      args.output = argv[index + 1] || "";
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

function getFootnoteDestinationId(rawId: string): string {
  return `footnote-${rawId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function normalizeLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  const firstWhitespace = trimmed.search(/\s/);
  const normalizedTarget =
    firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  return normalizedTarget.replace(/^<|>$/g, "");
}

function parseInlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  INLINE_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = INLINE_TOKEN_REGEX.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      const plainText = stripInlineMarkdown(text.slice(lastIndex, match.index));
      if (plainText) {
        segments.push({ text: plainText });
      }
    }

    const [token, imageAltText, linkLabel, linkTarget, footnoteId, autoLinkTarget] = match;
    if (imageAltText !== undefined) {
      const plainAltText = stripInlineMarkdown(imageAltText);
      if (plainAltText) {
        segments.push({ text: plainAltText });
      }
    } else if (linkLabel !== undefined && linkTarget !== undefined) {
      const normalizedTarget = normalizeLinkTarget(linkTarget);
      const plainLabel = stripInlineMarkdown(linkLabel) || normalizedTarget;
      segments.push({ text: plainLabel, link: normalizedTarget });
    } else if (footnoteId !== undefined) {
      segments.push({
        text: `[^${footnoteId}]`,
        goTo: getFootnoteDestinationId(footnoteId),
      });
    } else if (autoLinkTarget !== undefined) {
      segments.push({ text: autoLinkTarget, link: autoLinkTarget });
    }

    lastIndex = match.index + token.length;
    match = INLINE_TOKEN_REGEX.exec(text);
  }

  if (lastIndex < text.length) {
    const trailingText = stripInlineMarkdown(text.slice(lastIndex));
    if (trailingText) {
      segments.push({ text: trailingText });
    }
  }

  if (segments.length === 0) {
    segments.push({ text: stripInlineMarkdown(text) || " " });
  }

  return segments;
}

function renderInlineText(doc: PdfDocument, text: string, options: InlineRenderOptions): void {
  const segments = parseInlineSegments(text);
  const lastSegmentIndex = segments.length - 1;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const segmentOptions: PdfTextOptions = {
      continued: segmentIndex < lastSegmentIndex,
    };
    if (segmentIndex === 0) {
      if (options.indent !== undefined) {
        segmentOptions.indent = options.indent;
      }
      if (options.width !== undefined) {
        segmentOptions.width = options.width;
      }
      if (options.destination !== undefined) {
        segmentOptions.destination = options.destination;
      }
    } else if (options.width !== undefined) {
      segmentOptions.width = options.width;
    }
    if (segment.link !== undefined) {
      segmentOptions.link = segment.link;
    }
    if (segment.goTo !== undefined) {
      segmentOptions.goTo = segment.goTo;
    }

    doc
      .font(resolveFontForText(options.defaultFont, segment.text, options.cjkFontPath))
      .fontSize(options.fontSize);

    if (segmentIndex === 0 && options.x !== undefined && options.y !== undefined) {
      doc.text(segment.text, options.x, options.y, segmentOptions);
    } else {
      doc.text(segment.text, segmentOptions);
    }
  }
}

function isPipeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function parsePipeTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isPipeTableSeparatorRow(line: string): boolean {
  if (!isPipeTableRow(line)) {
    return false;
  }
  const cells = parsePipeTableRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_REGEX.test(cell));
}

function renderPipeTable(
  doc: PdfDocument,
  headerRow: string[],
  bodyRows: string[][],
  cjkFontPath: string | null
): void {
  const rows = [headerRow, ...bodyRows];
  const columnCount = rows.reduce(
    (maxColumns, row) => Math.max(maxColumns, row.length),
    0
  );
  if (columnCount === 0) {
    return;
  }

  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_value, columnIndex) => row[columnIndex] || "")
  );
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidth = tableWidth / columnCount;
  const tableStartX = doc.page.margins.left;
  let currentY = doc.y + 2;

  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex += 1) {
    const row = normalizedRows[rowIndex];
    const defaultFont = rowIndex === 0 ? "Helvetica-Bold" : "Helvetica";
    const fontSize = 10;
    let rowHeight = 0;

    for (const cell of row) {
      const measurementText = stripInlineMarkdown(cell) || " ";
      doc
        .font(resolveFontForText(defaultFont, measurementText, cjkFontPath))
        .fontSize(fontSize);
      const textHeight = doc.heightOfString(measurementText, {
        width: columnWidth - TABLE_CELL_PADDING * 2,
      });
      rowHeight = Math.max(rowHeight, textHeight + TABLE_CELL_PADDING * 2);
    }

    const pageBottomY = doc.page.height - doc.page.margins.bottom;
    if (currentY + rowHeight > pageBottomY) {
      doc.addPage();
      currentY = doc.y;
    }

    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const cellX = tableStartX + columnIndex * columnWidth;
      doc
        .rect(cellX, currentY, columnWidth, rowHeight)
        .strokeColor(RENDER_THEME_COLORS.tableBorder)
        .stroke();
      doc.strokeColor(RENDER_THEME_COLORS.bodyText);
      renderInlineText(doc, row[columnIndex], {
        defaultFont,
        fontSize,
        cjkFontPath,
        x: cellX + TABLE_CELL_PADDING,
        y: currentY + TABLE_CELL_PADDING,
        width: columnWidth - TABLE_CELL_PADDING * 2,
      });
    }

    currentY += rowHeight;
  }

  doc.y = currentY;
  doc.x = doc.page.margins.left;
  doc.moveDown(0.4);
}

function resolveCjkFontPath(): string | null {
  const fontCandidates =
    process.platform === "darwin"
      ? [
          "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
          "/Library/Fonts/Arial Unicode.ttf",
        ]
      : [
          "/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf",
          "/usr/share/fonts/opentype/noto/NotoSerifCJKtc-Regular.otf",
          "/usr/share/fonts/opentype/noto/NotoSansTC-Regular.otf",
          "/usr/share/fonts/truetype/noto/NotoSansTC-Regular.ttf",
          "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
          "/usr/share/fonts/truetype/arphic/uming.ttf",
          "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf",
        ];

  for (const fontPath of fontCandidates) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }

  return null;
}

function resolveFontForText(defaultFont: string, text: string, cjkFontPath: string | null): string {
  if (!cjkFontPath || !CJK_CHARACTER_REGEX.test(text)) {
    return defaultFont;
  }

  return cjkFontPath;
}

interface MarkdownLineContext {
  doc: PdfDocument;
  lines: string[];
  line: string;
  trimmed: string;
  lineIndex: number;
  cjkFontPath: string | null;
}

type MarkdownBlockHandler = (context: MarkdownLineContext) => number | null;

function isCodeFenceLine(trimmed: string): boolean {
  return trimmed.startsWith("```");
}

function renderCodeBlockLine(doc: PdfDocument, line: string, cjkFontPath: string | null): void {
  doc.font(resolveFontForText("Courier", line, cjkFontPath)).fontSize(10).text(line || " ");
}

function handleBlankLineBlock(context: MarkdownLineContext): number | null {
  if (context.trimmed) {
    return null;
  }

  context.doc.moveDown(0.4);
  return context.lineIndex;
}

function handlePipeTableBlock(context: MarkdownLineContext): number | null {
  if (
    !(
      isPipeTableRow(context.line) &&
      context.lineIndex + 1 < context.lines.length &&
      isPipeTableSeparatorRow(context.lines[context.lineIndex + 1])
    )
  ) {
    return null;
  }

  const headerRow = parsePipeTableRow(context.line);
  const bodyRows: string[][] = [];
  let tableLineIndex = context.lineIndex + 2;
  while (tableLineIndex < context.lines.length && isPipeTableRow(context.lines[tableLineIndex])) {
    bodyRows.push(parsePipeTableRow(context.lines[tableLineIndex]));
    tableLineIndex += 1;
  }
  renderPipeTable(context.doc, headerRow, bodyRows, context.cjkFontPath);
  return tableLineIndex - 1;
}

function handleHeadingBlock(context: MarkdownLineContext): number | null {
  const headingMatch = context.line.match(/^(#{1,6})\s+(.*)$/);
  if (!headingMatch) {
    return null;
  }

  const level = headingMatch[1].length;
  const fontSize = Math.max(12, 28 - level * 2);
  context.doc.fillColor(RENDER_THEME_COLORS.heading);
  renderInlineText(context.doc, headingMatch[2], {
    defaultFont: "Helvetica-Bold",
    fontSize,
    cjkFontPath: context.cjkFontPath,
  });
  context.doc.fillColor(RENDER_THEME_COLORS.bodyText);
  context.doc.moveDown(0.3);
  return context.lineIndex;
}

function handleDividerBlock(context: MarkdownLineContext): number | null {
  if (!/^(-{3,}|\*{3,}|_{3,})$/.test(context.trimmed)) {
    return null;
  }

  const y = context.doc.y + 3;
  context.doc
    .moveTo(context.doc.page.margins.left, y)
    .lineTo(context.doc.page.width - context.doc.page.margins.right, y)
    .strokeColor(RENDER_THEME_COLORS.divider)
    .stroke();
  context.doc.strokeColor(RENDER_THEME_COLORS.bodyText);
  context.doc.moveDown(0.6);
  return context.lineIndex;
}

function handleFootnoteDefinitionBlock(context: MarkdownLineContext): number | null {
  const footnoteDefinition = context.line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
  if (!footnoteDefinition) {
    return null;
  }

  const footnoteId = footnoteDefinition[1];
  renderInlineText(context.doc, `[${footnoteId}]: ${footnoteDefinition[2]}`, {
    defaultFont: "Helvetica",
    fontSize: 10,
    cjkFontPath: context.cjkFontPath,
    destination: getFootnoteDestinationId(footnoteId),
  });
  return context.lineIndex;
}

function handleBlockQuoteBlock(context: MarkdownLineContext): number | null {
  const blockQuote = context.line.match(/^\s*>\s?(.*)$/);
  if (!blockQuote) {
    return null;
  }

  context.doc.fillColor(RENDER_THEME_COLORS.blockQuoteText);
  renderInlineText(context.doc, `| ${blockQuote[1]}`, {
    defaultFont: "Helvetica-Oblique",
    fontSize: 11,
    cjkFontPath: context.cjkFontPath,
  });
  context.doc.fillColor(RENDER_THEME_COLORS.bodyText);
  return context.lineIndex;
}

function handleUnorderedListBlock(context: MarkdownLineContext): number | null {
  const unorderedList = context.line.match(/^\s*[-*+]\s+(.*)$/);
  if (!unorderedList) {
    return null;
  }

  renderInlineText(context.doc, `• ${unorderedList[1]}`, {
    defaultFont: "Helvetica",
    fontSize: 11,
    cjkFontPath: context.cjkFontPath,
    indent: 12,
  });
  return context.lineIndex;
}

function handleOrderedListBlock(context: MarkdownLineContext): number | null {
  const orderedList = context.line.match(/^\s*(\d+)\.\s+(.*)$/);
  if (!orderedList) {
    return null;
  }

  renderInlineText(context.doc, `${orderedList[1]}. ${orderedList[2]}`, {
    defaultFont: "Helvetica",
    fontSize: 11,
    cjkFontPath: context.cjkFontPath,
    indent: 12,
  });
  return context.lineIndex;
}

function renderParagraphBlock(context: MarkdownLineContext): number {
  renderInlineText(context.doc, context.line, {
    defaultFont: "Helvetica",
    fontSize: 11,
    cjkFontPath: context.cjkFontPath,
  });
  return context.lineIndex;
}

function renderMarkdownToPdf(doc: PdfDocument, markdown: string, cjkFontPath: string | null): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCodeBlock = false;
  const blockHandlers: MarkdownBlockHandler[] = [
    handleBlankLineBlock,
    handlePipeTableBlock,
    handleHeadingBlock,
    handleDividerBlock,
    handleFootnoteDefinitionBlock,
    handleBlockQuoteBlock,
    handleUnorderedListBlock,
    handleOrderedListBlock,
    renderParagraphBlock,
  ];
  doc.fillColor(RENDER_THEME_COLORS.bodyText);
  doc.strokeColor(RENDER_THEME_COLORS.bodyText);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (isCodeFenceLine(trimmed)) {
      inCodeBlock = !inCodeBlock;
      doc.moveDown(0.25);
      continue;
    }

    if (inCodeBlock) {
      renderCodeBlockLine(doc, line, cjkFontPath);
      continue;
    }

    const context: MarkdownLineContext = { doc, lines, line, trimmed, lineIndex, cjkFontPath };
    for (const handleBlock of blockHandlers) {
      const nextLineIndex = handleBlock(context);
      if (nextLineIndex !== null) {
        lineIndex = nextLineIndex;
        break;
      }
    }
  }
}

async function convertMarkdownToPdf(inputPath: string, outputPath: string): Promise<void> {
  const markdown = await fsp.readFile(inputPath, "utf8");
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const cjkFontPath = resolveCjkFontPath();
  renderMarkdownToPdf(doc, markdown, cjkFontPath);
  doc.end();
  await streamPromises.finished(stream);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.input) {
    printHelp();
    throw new Error("Missing required argument: --input");
  }

  const inputPath = path.resolve(process.cwd(), args.input);
  const defaultOutputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.pdf`
  );
  const outputPath = path.resolve(process.cwd(), args.output || defaultOutputPath);

  await convertMarkdownToPdf(inputPath, outputPath);
  console.log(`PDF generated: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to convert markdown to PDF: ${message}`);
  process.exit(1);
});
