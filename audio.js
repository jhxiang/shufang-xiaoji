// Offline Web Audio Ambient Sound Synthesizer for Focus Reading Timer
// Zero external audio files required; supports Rain / Fireplace / Quiet Night
(() => {
  'use strict';

  class AmbientAudio {
    constructor() {
      this.ctx = null;
      this.source = null;
      this.gainNode = null;
      this.mode = 'off';
    }

    stop() {
      if (this.source) {
        try { this.source.stop(); } catch { /* ignore */ }
        try { this.source.disconnect(); } catch { /* ignore */ }
        this.source = null;
      }
      if (this.gainNode) {
        try { this.gainNode.disconnect(); } catch { /* ignore */ }
        this.gainNode = null;
      }
      this.mode = 'off';
    }

    setMode(mode) {
      this.stop();
      if (!mode || mode === 'off') return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      try {
        if (!this.ctx) this.ctx = new AudioCtx();
        if (this.ctx.state === 'suspended') this.ctx.resume();

        const sampleRate = this.ctx.sampleRate;
        const length = sampleRate * 4;
        const buffer = this.ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);

        // Generate pink/brownian noise base
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        let lastOut = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          if (mode === 'fire') {
            // Warm brown rumble + subtle crackle
            lastOut = (lastOut + 0.025 * white) / 1.025;
            const crackle = Math.random() > 0.9985 ? (Math.random() - 0.5) * 0.45 : 0;
            data[i] = lastOut * 2.2 + crackle;
          } else {
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.055;
            b6 = white * 0.115926;
          }
        }

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;

        const filter = this.ctx.createBiquadFilter();
        if (mode === 'rain') {
          filter.type = 'bandpass';
          filter.frequency.value = 950;
          filter.Q.value = 0.5;
        } else if (mode === 'fire') {
          filter.type = 'lowpass';
          filter.frequency.value = 420;
        } else {
          // night soft breeze
          filter.type = 'lowpass';
          filter.frequency.value = 680;
        }

        const gain = this.ctx.createGain();
        gain.gain.value = mode === 'rain' ? 0.22 : (mode === 'fire' ? 0.28 : 0.14);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        src.start();

        this.source = src;
        this.gainNode = gain;
        this.mode = mode;
      } catch {
        this.mode = 'off';
      }
    }
  }

  window.AmbientAudio = new AmbientAudio();
})();
