#!/usr/bin/env node

interface CliArgs {
  input: string;
  output: string;
  help: boolean;
}

interface FsModule {
  createWriteStream(filePath: string): unknown;
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
}

interface PdfPage {
  margins: { left: number; right: number };
  width: number;
}

interface PdfDocument {
  y: number;
  page: PdfPage;
  pipe(stream: unknown): void;
  moveDown(lines?: number): PdfDocument;
  font(name: string): PdfDocument;
  fontSize(size: number): PdfDocument;
  text(content: string, options?: PdfTextOptions): PdfDocument;
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

function renderMarkdownToPdf(doc: PdfDocument, markdown: string): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      doc.moveDown(0.25);
      continue;
    }

    if (inCodeBlock) {
      doc.font("Courier").fontSize(10).text(line || " ");
      continue;
    }

    if (!trimmed) {
      doc.moveDown(0.4);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = stripInlineMarkdown(headingMatch[2]);
      const fontSize = Math.max(12, 28 - level * 2);
      doc.font("Helvetica-Bold").fontSize(fontSize).text(headingText);
      doc.moveDown(0.3);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const y = doc.y + 3;
      doc
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .strokeColor("#cccccc")
        .stroke();
      doc.strokeColor("black");
      doc.moveDown(0.6);
      continue;
    }

    const blockQuote = line.match(/^\s*>\s?(.*)$/);
    if (blockQuote) {
      doc
        .font("Helvetica-Oblique")
        .fontSize(11)
        .fillColor("#555555")
        .text(`| ${stripInlineMarkdown(blockQuote[1])}`);
      doc.fillColor("black");
      continue;
    }

    const unorderedList = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedList) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`• ${stripInlineMarkdown(unorderedList[1])}`, { indent: 12 });
      continue;
    }

    const orderedList = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (orderedList) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`${orderedList[1]}. ${stripInlineMarkdown(orderedList[2])}`, {
          indent: 12,
        });
      continue;
    }

    doc.font("Helvetica").fontSize(11).text(stripInlineMarkdown(line));
  }
}

async function convertMarkdownToPdf(inputPath: string, outputPath: string): Promise<void> {
  const markdown = await fsp.readFile(inputPath, "utf8");
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  renderMarkdownToPdf(doc, markdown);
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
