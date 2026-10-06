export interface ReceiptCostSample {
  result: 'confirmed' | 'rejected' | 'timeout' | 'interrupted'
  packet: 'single' | 'section' | 'none'
  gameMs: number
}

export class ReceiptCostWindow {
  private context = ''
  private values: number[] = []

  private select(context: string): void {
    if (context === this.context) return
    this.context = context
    this.values = []
  }

  observe(context: string, sample: ReceiptCostSample): void {
    this.select(context)
    if (sample.result !== 'confirmed' || !['single', 'section'].includes(sample.packet) || !Number.isFinite(sample.gameMs) || sample.gameMs < 0) return
    this.values.push(sample.gameMs)
    if (this.values.length > 32) this.values.shift()
  }

  seconds(context: string): number {
    this.select(context)
    return this.values.length >= 8 ? this.values.reduce((total, value) => total + value, 0) / (1000 * this.values.length) : 0
  }
}
