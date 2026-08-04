$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outPath = Join-Path $root 'Buscor_Stakeholder_Proposal.docx'
$temp = Join-Path $root 'docx_temp'
if (Test-Path $outPath) { Remove-Item $outPath -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp '_rels') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp 'word') | Out-Null
$date = Get-Date -Format 'MMMM dd, yyyy'
$letter = @"
$date

Buscor Stakeholders
Buscor Ticketing Committee

Subject: Proposal for Buscor Online Ticket Purchase Platform

Dear Buscor Stakeholders,

I am pleased to present this formal proposal for the development and delivery of the Buscor online ticket purchase platform. The current project has successfully implemented the backend payment flow, MongoDB purchase persistence, active trip validation based on purchase history, and customer-facing payment redirection logic. The only remaining item is the final UI design layer.

Project Summary:
- Backend integration with PayFast for ticket payment initiation and ITN notification handling.
- Persistent storage of ticket purchases in MongoDB, ensuring reliable transaction history.
- Validation of active trips using paid purchase history rather than card metadata.
- Renewal logic to start new tickets on the following Monday when the current ticket has two days or less remaining.
- Frontend support for payment initiation, status polling, and failure notification in the browser.

Business Benefits:
- Improved customer experience through a more reliable online ticket purchase process.
- Stronger compliance with Buscor’s fare and ticketing rules via server-side validation.
- Reduced manual intervention by using payment history instead of manual card state tracking.
- Readiness for stakeholder review and handoff once the UI design is finalized.

Current Status:
- Core platform logic is complete and ready for user interface polish.
- The system can validate alias numbers, create purchase records, process PayFast notifications, and build ticket receipts.
- The remaining scope is to deliver a polished, branded frontend design for the website.

Proposed Next Steps:
1. Complete the UI/UX design and styling for the customer-facing ticket purchase pages.
2. Conduct stakeholder review sessions for the proposed flows and branding.
3. Perform user acceptance testing with Buscor staff and representative customers.
4. Deploy the final solution and monitor initial ticket purchases for quality assurance.

Conclusion:
This proposal represents a mature and viable online ticketing solution for Buscor. With the backend and payment infrastructure already in place, completing the visual design will enable a full launch and a strong stakeholder presentation.

Thank you for your consideration. I look forward to discussing this proposal and advancing Buscor’s digital ticketing capabilities.

Sincerely,

[Your Name]
[Title or Role]
Buscor Ticketing Project
"@
$contentTypes = @"
<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"@
$rels = @"
<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"@
$docBody = ($letter -split "`n" | ForEach-Object {
    $line = $_ -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;'
    "<w:p><w:r><w:t>$line</w:t></w:r></w:p>"
}) -join ''
$document = @"
<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    $docBody
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
"@
[System.IO.File]::WriteAllText((Join-Path $temp '[Content_Types].xml'), $contentTypes, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText((Join-Path $temp '_rels\.rels'), $rels, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText((Join-Path $temp 'word\document.xml'), $document, [System.Text.Encoding]::UTF8)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($temp, $outPath)
Remove-Item $temp -Recurse -Force
Write-Output "Created $outPath"
