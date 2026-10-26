-- =====================================================================
-- Flexo Supplier Portal — GRPO export (SAP Business One on HANA)
-- Portal:  SAP data → "Import GRPO CSV"
-- Columns: DocNum, CardCode, CardName, DocDate, BaseRef, BaseLine,
--          ItemCode, Dscription, Quantity, unitMsr
--
-- What it returns
--   Every line of non-cancelled Goods Receipt POs posted on/after the
--   FROM date that was copied from a Purchase Order. Quantity is NET of
--   any Goods Returns made against that GRPO line, so returned goods
--   can't be billed.
--
-- FROM date: set it to the pilot start date (edit the literal below).
--   The portal deducts quantities billed through the portal itself. It
--   does not know about invoices paid outside it, so receipts from before
--   the pilot are left out on purpose. Invoices for them land in
--   "Exceptions" for AP to check manually instead of being paid twice.
-- =====================================================================
SELECT
    H."DocNum"                              AS "DocNum",
    H."CardCode"                            AS "CardCode",
    H."CardName"                            AS "CardName",
    TO_VARCHAR(H."DocDate", 'YYYY-MM-DD')   AS "DocDate",
    P."DocNum"                              AS "BaseRef",    -- PO number
    L."BaseLine"                            AS "BaseLine",   -- PO line (POR1.LineNum)
    L."ItemCode"                            AS "ItemCode",
    L."Dscription"                          AS "Dscription",
    L."Quantity" - IFNULL(R."ReturnedQty", 0) AS "Quantity",
    L."unitMsr"                             AS "unitMsr"
FROM OPDN H
INNER JOIN PDN1 L ON L."DocEntry" = H."DocEntry"
INNER JOIN OPOR P ON P."DocEntry" = L."BaseEntry"
                 AND L."BaseType" = 22                      -- 22 = Purchase Order
LEFT JOIN (
    SELECT RL."BaseEntry", RL."BaseLine", SUM(RL."Quantity") AS "ReturnedQty"
    FROM RPD1 RL
    INNER JOIN ORPD RH ON RH."DocEntry" = RL."DocEntry"
    WHERE RL."BaseType" = 20                                -- 20 = Goods Receipt PO
      AND RH."CANCELED" = 'N'
    GROUP BY RL."BaseEntry", RL."BaseLine"
) R ON R."BaseEntry" = L."DocEntry" AND R."BaseLine" = L."LineNum"
WHERE H."CANCELED" = 'N'                                    -- also skips cancellation docs ('C')
  AND H."DocDate" >= TO_DATE('2026-11-01')                  -- << FROM date (pilot start)
  AND L."Quantity" - IFNULL(R."ReturnedQty", 0) > 0
ORDER BY H."DocNum", L."LineNum";
