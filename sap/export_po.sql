-- =====================================================================
-- Flexo Supplier Portal — Purchase Order export (SAP Business One on HANA)
-- Portal:  SAP data → "Import PO CSV"
-- Columns: DocNum, CardCode, CardName, DocDate, DocCur, LineNum,
--          ItemCode, Dscription, Quantity, unitMsr, Price
--
-- What it returns
--   All lines of non-cancelled POs that either
--     (a) are still open and dated within the last 12 months, or
--     (b) have a GRPO posted on/after the FROM date (even if the PO is
--         now closed because everything was received — the supplier's
--         invoice usually arrives after that).
--   Use the SAME FROM date as export_grpo.sql.
--
-- Price = POR1."Price": unit price after line discount, VAT-exclusive,
--   per purchasing UoM. The portal compares the supplier's invoice unit
--   price against this (default tolerance ±0.5%).
-- =====================================================================
SELECT
    H."DocNum"                              AS "DocNum",
    H."CardCode"                            AS "CardCode",
    H."CardName"                            AS "CardName",
    TO_VARCHAR(H."DocDate", 'YYYY-MM-DD')   AS "DocDate",
    H."DocCur"                              AS "DocCur",
    L."LineNum"                             AS "LineNum",
    L."ItemCode"                            AS "ItemCode",
    L."Dscription"                          AS "Dscription",
    L."Quantity"                            AS "Quantity",
    L."unitMsr"                             AS "unitMsr",
    L."Price"                               AS "Price"
FROM OPOR H
INNER JOIN POR1 L ON L."DocEntry" = H."DocEntry"
WHERE H."CANCELED" = 'N'
  AND (
        (H."DocStatus" = 'O' AND H."DocDate" >= ADD_MONTHS(CURRENT_DATE, -12))
     OR EXISTS (
        SELECT 1
        FROM PDN1 GL
        INNER JOIN OPDN GH ON GH."DocEntry" = GL."DocEntry"
        WHERE GL."BaseType" = 22
          AND GL."BaseEntry" = H."DocEntry"
          AND GH."CANCELED" = 'N'
          AND GH."DocDate" >= TO_DATE('2026-11-01')         -- << FROM date (same as GRPO export)
     )
  )
ORDER BY H."DocNum", L."LineNum";
