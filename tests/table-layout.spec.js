const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(__dirname, "fixtures", "table-layout.md");

function runMarkdownConversion(outputPdfPath) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(
    npmCommand,
    [
      "run",
      "convert",
      "--",
      "--input",
      fixturePath,
      "--output",
      outputPdfPath,
    ],
    {
      cwd: repoRoot,
      stdio: "pipe",
    }
  );
}

async function getAnchorXCoordinates(pdfPath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const standardFontDataUrl = path.join(pdfjsRoot, "standard_fonts/");
  const data = new Uint8Array(readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    standardFontDataUrl,
  });
  const pdfDocument = await loadingTask.promise;
  const firstPage = await pdfDocument.getPage(1);
  const textContent = await firstPage.getTextContent();

  const beforeAnchor = textContent.items.find(
    (item) => typeof item.str === "string" && item.str.includes("BEFORE-TABLE-ANCHOR")
  );
  const afterAnchor = textContent.items.find(
    (item) => typeof item.str === "string" && item.str.includes("AFTER-TABLE-ANCHOR")
  );

  if (!beforeAnchor || !afterAnchor) {
    throw new Error("Failed to locate table regression anchors in generated PDF.");
  }

  return {
    beforeX: beforeAnchor.transform[4],
    afterX: afterAnchor.transform[4],
  };
}

test("content after a table is not right-shifted", async () => {
  const outputPdfPath = test.info().outputPath("table-layout.pdf");
  runMarkdownConversion(outputPdfPath);
  const { beforeX, afterX } = await getAnchorXCoordinates(outputPdfPath);

  expect(afterX, "Post-table content shifted right from baseline alignment.").toBeLessThanOrEqual(
    beforeX + 1
  );
});
