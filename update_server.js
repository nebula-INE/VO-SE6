const fs = require('fs');
let serverCode = fs.readFileSync('server.js', 'utf8');

const renderEndpoint = `
// VOSE Engine Render Endpoint (API Bridge)
app.post('/api/py/render-wav', async (req, res) => {
  const { notes, voicebank, tempo } = req.body;
  if (!notes || !notes.length) {
    return res.status(400).json({ success: false, error: 'No notes provided' });
  }

  try {
    // 1. Simulate the Python/C++ rendering pipeline delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 2. Generate a valid WAV file in pure Node (as a placeholder for the real C++ output)
    // In a real environment, this would call:
    // child_process.exec(\`python3 render_cli.py input.json output.wav\`)
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const outPath = path.join(tempDir, \`render_\${Date.now()}.wav\`);
    
    // Generate 1-second 440Hz sine wave WAV
    const sampleRate = 44100;
    const duration = 2; // seconds
    const numSamples = sampleRate * duration;
    const buffer = Buffer.alloc(44 + numSamples * 2);
    
    // RIFF Header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + numSamples * 2, 4);
    buffer.write('WAVE', 8);
    // fmt subchunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
    buffer.writeUInt16LE(1, 22); // NumChannels
    buffer.writeUInt32LE(sampleRate, 24); // SampleRate
    buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
    buffer.writeUInt16LE(2, 32); // BlockAlign
    buffer.writeUInt16LE(16, 34); // BitsPerSample
    // data subchunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(numSamples * 2, 40);
    
    // Write samples
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * 440 * t) * 32767 * 0.5;
      buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
    }
    
    fs.writeFileSync(outPath, buffer);
    
    // Return the audio URL
    const fileUrl = \`/temp/\${path.basename(outPath)}\`;
    res.json({ success: true, audioUrl: fileUrl });
    
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve temp dir so we can play the wav
app.use('/temp', express.static(path.join(__dirname, 'temp')));
`;

if (!serverCode.includes('/api/py/render-wav')) {
  serverCode = serverCode.replace('// System & PySide6 Status API', renderEndpoint + '\n\n// System & PySide6 Status API');
  fs.writeFileSync('server.js', serverCode);
  console.log("Added render endpoint to server.js");
}
