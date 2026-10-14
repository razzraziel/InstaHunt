Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$setupFolder = $PSScriptRoot
$serverFolder = Split-Path $setupFolder -Parent
$version = (Get-Content (Join-Path $setupFolder 'version.json') -Raw | ConvertFrom-Json).version
$form = New-Object System.Windows.Forms.Form
$form.Text = "Insta Hunt v$version - Add or Remove"
$form.ClientSize = New-Object System.Drawing.Size(520, 340)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$title = New-Object System.Windows.Forms.Label
$title.Text = "Insta Hunt v$version"
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.Size = New-Object System.Drawing.Size(470, 28)
$title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$text = New-Object System.Windows.Forms.Label
$text.Text = "Stop your server before making changes.`r`nPlace the InstaHunt folder in your server main folder`r`n(the folder containing src and database).`r`n`r`nAdd: Adds and enables Insta Hunt. Use .h in game.`r`nRemove: Restores backed-up files when available.`r`nLater server edits are preserved; only Insta Hunt is removed."
$text.Location = New-Object System.Drawing.Point(24, 62)
$text.Size = New-Object System.Drawing.Size(470, 190)
$install = New-Object System.Windows.Forms.Button
$install.Text = 'Add'
$install.Location = New-Object System.Drawing.Point(24, 274)
$install.Size = New-Object System.Drawing.Size(204, 42)
$restore = New-Object System.Windows.Forms.Button
$restore.Text = 'Remove'
$restore.Location = New-Object System.Drawing.Point(292, 274)
$restore.Size = New-Object System.Drawing.Size(204, 42)
$form.Controls.AddRange(@($title, $text, $install, $restore))

function Invoke-Setup([string]$action) {
    $install.Enabled = $false
    $restore.Enabled = $false
    $form.UseWaitCursor = $true
    $form.ControlBox = $false
    try {
        if (!(Test-Path (Join-Path $serverFolder 'src\GameServer\Network\Opcodes.js')) -or !(Test-Path (Join-Path $serverFolder 'src\Database.js'))) { throw 'Place the InstaHunt folder in your server main folder, then open AddOrRemove again.' }
        $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
            $_.CommandLine -and ($_.CommandLine.IndexOf($serverFolder, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine -match 'src[\\/]NodeL2')
        }
        if ($running) { throw 'The server is running. Stop it and try again.' }
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
        if (!$nodePath) {
            foreach ($candidate in @((Join-Path $serverFolder 'node.exe'), (Join-Path $serverFolder 'runtime\node.exe'), (Join-Path $serverFolder 'node\node.exe'))) {
                if (Test-Path $candidate) { $nodePath = $candidate; break }
            }
        }
        if (!$nodePath) { throw 'Node.js could not be found. Check your Node.js installation or server folder.' }
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = $nodePath
        $process.StartInfo.Arguments = '"' + (Join-Path $setupFolder 'ServerIntegration.js') + '" ' + $action
        $process.StartInfo.WorkingDirectory = $serverFolder
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $process.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        [void]$process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        while (!$process.WaitForExit(100)) { [System.Windows.Forms.Application]::DoEvents() }
        $output = $outputTask.Result
        $errorText = $errorTask.Result
        try { $result = $output.Trim() | ConvertFrom-Json } catch { throw "Setup could not run.`r`n$errorText`r`n$output" }
        if (!$result.ok) { throw $result.message }
        [void][System.Windows.Forms.MessageBox]::Show($form, $result.message, 'Insta Hunt', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch {
        [void][System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Insta Hunt', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } finally {
        $install.Enabled = $true
        $restore.Enabled = $true
        $form.UseWaitCursor = $false
        $form.ControlBox = $true
    }
}

$install.Add_Click({ Invoke-Setup 'install' })
$restore.Add_Click({ Invoke-Setup 'uninstall' })
[void]$form.ShowDialog()
