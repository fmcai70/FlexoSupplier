-- Optional sample data so you can try the full flow right after setup.
-- Every row has "sample": true, so Flexo staff can remove it with
-- SAP data → "Clear sample data" before go-live.
--
-- Try it:
--   Supplier sign-in : "Polymer Resins Trading Corp. · V-10001", access code 111111
--   Staff sign-in    : any name, PIN 2026 (change it under Rules)
--
-- A matching test invoice (everything clears for payment):
--   Invoice no. SI-0001, PO 4500101
--   Line 1: LLDPE Film Grade Resin   qty 5000  KG   unit price 86.50
--   Line 2: Masterbatch White        qty 400   KG   unit price 145.00
--   VAT 58,860.00 · Total amount due 549,360.00

insert into public.docs (collection, id, data) values
('settings', 'app', '{"priceTolPct":0.5,"qtyTolPct":0,"amountTol":1,"staffPin":"2026","vatRate":12}'),

('vendors', 'V-10001', '{"code":"V-10001","name":"Polymer Resins Trading Corp.","accessCode":"111111","active":true,"sample":true}'),
('vendors', 'V-10002', '{"code":"V-10002","name":"Inkline Printing Supplies Inc.","accessCode":"222222","active":true,"sample":true}'),

('sap_po', 'PO-4500101', '{"poNo":"4500101","vendorCode":"V-10001","vendorName":"Polymer Resins Trading Corp.","docDate":"2026-09-01","currency":"PHP","sample":true,"lines":[
  {"line":"0","itemCode":"RM-PE-001","desc":"LLDPE Film Grade Resin","qty":10000,"uom":"KG","price":86.50},
  {"line":"1","itemCode":"RM-MB-010","desc":"Masterbatch White","qty":800,"uom":"KG","price":145.00}]}'),
('sap_po', 'PO-4500102', '{"poNo":"4500102","vendorCode":"V-10001","vendorName":"Polymer Resins Trading Corp.","docDate":"2026-09-15","currency":"PHP","sample":true,"lines":[
  {"line":"0","itemCode":"RM-PP-003","desc":"BOPP Film 20 micron","qty":3000,"uom":"KG","price":118.00}]}'),
('sap_po', 'PO-4500201', '{"poNo":"4500201","vendorCode":"V-10002","vendorName":"Inkline Printing Supplies Inc.","docDate":"2026-09-05","currency":"PHP","sample":true,"lines":[
  {"line":"0","itemCode":"RM-INK-CY","desc":"Flexo Ink Cyan","qty":200,"uom":"KG","price":520.00},
  {"line":"1","itemCode":"RM-INK-MG","desc":"Flexo Ink Magenta","qty":200,"uom":"KG","price":535.00}]}'),

('sap_grpo', 'GR-7700101', '{"grpoNo":"7700101","vendorCode":"V-10001","vendorName":"Polymer Resins Trading Corp.","docDate":"2026-09-10","poNo":"4500101","sample":true,"lines":[
  {"poNo":"4500101","poLine":"0","itemCode":"RM-PE-001","desc":"LLDPE Film Grade Resin","qty":5000,"uom":"KG"},
  {"poNo":"4500101","poLine":"1","itemCode":"RM-MB-010","desc":"Masterbatch White","qty":400,"uom":"KG"}]}'),
('sap_grpo', 'GR-7700201', '{"grpoNo":"7700201","vendorCode":"V-10002","vendorName":"Inkline Printing Supplies Inc.","docDate":"2026-09-12","poNo":"4500201","sample":true,"lines":[
  {"poNo":"4500201","poLine":"0","itemCode":"RM-INK-CY","desc":"Flexo Ink Cyan","qty":150,"uom":"KG"}]}')
on conflict (collection, id) do nothing;
