# Makes THIS PC trust the self-signed JARVIS certificate (current user only), so the signed installer shows
# "Erick (J.A.R.V.I.S) - autoassinado" as publisher instead of "unknown". Run it yourself, on purpose:
# adding a root certificate is a trust decision, and Windows will ask you to confirm it.
# This does NOT remove SmartScreen warnings on OTHER PCs: that needs a certificate from a public authority.
param([string]$Thumbprint = $env:JARVIS_SIGN_SHA1)
if (-not $Thumbprint) { throw 'Pass -Thumbprint or set JARVIS_SIGN_SHA1' }
$cert = Get-Item "Cert:\CurrentUser\My\$Thumbprint"
$cer = Join-Path $env:TEMP 'jarvis-signing.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null          # public part only
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null   # Windows asks for confirmation here
[IO.File]::Delete($cer)
'Trusted for this user. Undo: remove the certificate from certmgr.msc (Trusted Publishers and Trusted Root).'
