param([Parameter(Mandatory=$true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Huihui Desktop')
$synth.Rate = -1
$directory = (New-Item -Path $OutputDirectory -ItemType Directory -Force).FullName
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, 'Sixteen', 'Mono')
$samples = [ordered]@{
  'risk-code-demo.wav' = '请把短信验证码念给我，我会替你办理退款。'
  'risk-transfer-demo.wav' = '先打开屏幕共享，再把钱转到安全账户。'
  'normal-reminder-demo.wav' = '请勿将验证码告诉任何人。谢谢，请到正常柜台办理。'
}
try {
  foreach ($file in $samples.Keys) {
    $synth.SetOutputToWaveFile((Join-Path $directory $file), $format)
    $synth.Speak($samples[$file])
    $synth.SetOutputToNull()
  }
} finally {
  $synth.Dispose()
}
