function hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h || 1;
}

export class SeededRng {
    private state: number;
    constructor(seed: string) {
        this.state = hashString(seed);
    }

    next(): number {
        let t = (this.state + 0x6d2b79f5) | 0;
        this.state = t;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    float(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    pick<T>(arr: readonly T[]): T {
        if (arr.length === 0) throw new Error('SeededRng.pick: empty array');
        return arr[this.int(0, arr.length - 1)]!;
    }

    alphanumeric(len: number): string {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let s = '';
        for (let i = 0; i < len; i++) s += this.pick([...chars]);
        return s;
    }

    uuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (this.next() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
}
