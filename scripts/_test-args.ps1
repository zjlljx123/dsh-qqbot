param([int]$Delay = 0)
"ran at $(Get-Date -Format 'HH:mm:ss') delay=$Delay args=$($args -join ' ')" | Out-File "D:\work\DshWorkspace\restart-test-marker.txt" -Encoding UTF8
