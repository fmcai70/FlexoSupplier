-- =====================================================================
-- Run once before the first import. Both should return NO rows.
-- =====================================================================

-- 1) Duplicate PO numbers. The portal identifies a PO by DocNum only. If
--    Flexo uses several numbering series (e.g. one per year or branch),
--    the same DocNum can exist twice and the portal would mix them up.
SELECT "DocNum", COUNT(*) AS "Times"
FROM OPOR
WHERE "CANCELED" = 'N' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -24)
GROUP BY "DocNum" HAVING COUNT(*) > 1;

-- 2) Same check for GRPO numbers.
SELECT "DocNum", COUNT(*) AS "Times"
FROM OPDN
WHERE "CANCELED" = 'N' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -24)
GROUP BY "DocNum" HAVING COUNT(*) > 1;

-- Info: POs with a line currency different from the header currency
-- (the portal assumes one currency per PO).
SELECT DISTINCT H."DocNum", H."DocCur", L."Currency"
FROM OPOR H INNER JOIN POR1 L ON L."DocEntry" = H."DocEntry"
WHERE H."CANCELED" = 'N' AND H."DocStatus" = 'O'
  AND IFNULL(L."Currency", H."DocCur") <> H."DocCur";
