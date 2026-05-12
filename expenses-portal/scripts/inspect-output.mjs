import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("smoke-output.xlsx");
const s = wb.worksheets[0];
for (let r = 7; r <= 9; r++) {
  console.log(
    `row ${r}: B="${s.getCell(`B${r}`).value}" C="${s.getCell(`C${r}`).value}" D="${s.getCell(`D${r}`).value}" G=${s.getCell(`G${r}`).value}`,
  );
}
