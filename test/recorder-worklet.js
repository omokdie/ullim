// 시험용: 들어온 소리를 그대로 메인 스레드로 보냄 (4096 샘플씩, 왼쪽 채널)
class Rec extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.on = true; this.port.onmessage = e => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    const len = 128;
    for (let i = 0; i < len; i++) { this.buf[this.n++] = ch ? ch[i] : 0; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; } }
    return true;
  }
}
registerProcessor('ul-rec', Rec);
