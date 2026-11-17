Get-Process -Id 33424 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-List | Out-String
"--- profile mtime ---"
(Get-Item "C:\Users\lonsdor\.dsh\profiles\desktop\package.json").LastWriteTime
(Get-Item "C:\Users\lonsdor\.dsh\profiles\desktop\node_modules\dsh-flowgate").LinkType
"--- resources ---"
Get-ChildItem "D:\Programs\deepseek harness desktop v0.2.1\resources" -ErrorAction SilentlyContinue | Select-Object Name,Mode | Format-Table -AutoSize | Out-String
