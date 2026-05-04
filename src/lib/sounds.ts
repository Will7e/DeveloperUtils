// ============================================================
// Sound Effects — Subtle audio feedback for code execution
// ============================================================

const audioContext = typeof window !== "undefined" ? new (window.AudioContext || (window as any).webkitAudioContext)() : null;

type SoundType = "run" | "success" | "error";

const SOUNDS: Record<SoundType, { freq: number[]; dur: number[]; type: OscillatorType }> = {
  run: {
    freq: [440, 520],
    dur: [0.06, 0.06],
    type: "sine",
  },
  success: {
    freq: [523, 659, 784],
    dur: [0.08, 0.08, 0.12],
    type: "sine",
  },
  error: {
    freq: [330, 260],
    dur: [0.1, 0.15],
    type: "triangle",
  },
};

export function playSound(type: SoundType) {
  if (!audioContext) return;

  // Resume audio context if suspended (browser autoplay policy)
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  const config = SOUNDS[type];
  let time = audioContext.currentTime;

  config.freq.forEach((freq, i) => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const duration = config.dur[i] ?? 0.1;

    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(freq, time);

    gainNode.gain.setValueAtTime(0.08, time);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(time);
    oscillator.stop(time + duration);

    time += duration;
  });
}
