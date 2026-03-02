# md-to-pdf Skill

Convert Markdown files to PDF with a Node.js + TypeScript CLI script.

## Prerequisites

- Node.js 24+ (LTS)
- npm

## Install

```bash
git clone git@github.com:Willseed/md-2-pdf.git
cd md-2-pdf
npm install
```

## Usage

```bash
npm run convert -- --input /path/to/file.md --output /path/to/file.pdf
```

- `--input` (or `-i`) is required.
- `--output` (or `-o`) is optional.
- If `--output` is omitted, the PDF is created next to the input Markdown file.

## Regression Verification

Run the automated Playwright check for table layout regression:

```bash
npm run verify:table-layout
```

## Skill Installation (skills CLI)

```bash
npx skills add Willseed/md-2-pdf
```
