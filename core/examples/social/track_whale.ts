import pmxt from '../../src';

function fmt(address: string): string {
    if (address.length > 10) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    return address;
}

async function run() {
    const exchange = new pmxt.Polymarket();

    // -- Step 1: Define and find whales -----------------------------------------------
    // For simplicity, here I assume the trader with the largest volume is a "whale"
    console.log('Fetching top volume traders in all time...\n');
    const whales: any[] = await (exchange as any).getV1Leaderboard({
        category: 'OVERALL',
        timePeriod: 'ALL',
        orderBy: 'VOL',
        limit: 10,
    });

    console.log('Rank  Name                           Address        Volume (USDC)   PnL (USDC)');
    console.log('-'.repeat(82));
    for (const w of whales) {
        const name = fmt(w.userName ?? '').padEnd(30);
        const addr = fmt(w.proxyWallet ?? '').padEnd(14);
        const vol = `$${((w.vol ?? 0) / 1_000_000).toFixed(1)}M`.padStart(14);
        const pnl = `$${((w.pnl ?? 0) / 1_000).toFixed(1)}K`.padStart(12);
        console.log(`  ${String(w.rank ?? '').padStart(2)}  ${name} ${addr} ${vol} ${pnl}`);
    }

    // -- Step 2: Watch the top whale --------------------------------------------------
    const whale = whales[0];
    const label = whale.userName;
    const address = whale.proxyWallet;
    console.log(`\nWatching ${label} (${address}) ...`);
    console.log('Press Ctrl+C to stop.\n');

    let running = true;
    process.on('SIGINT', async () => {
        console.log('Stopping...');
        running = false;
        await exchange.unwatchAddress(address);
        process.exit(0);
    });

    try {
        while (running) {
            const snapshot = await exchange.watchAddress(address, ['trades', 'positions']);
            console.log(`\n[Update @ ${new Date().toLocaleTimeString()}]`);
            if (snapshot.trades) {
                for (const t of snapshot.trades) {
                    console.log(`  Trade: ${t.side.toUpperCase()} ${t.amount.toFixed(0)} shares @ $${t.price.toFixed(3)}`);
                }
            }
            if (snapshot.positions) {
                for (const p of snapshot.positions) {
                    console.log(`  Position: ${p.outcomeLabel} size=${p.size.toFixed(2)} entry=$${p.entryPrice.toFixed(3)}`);
                }
            }
        }
    } catch (err) {
        console.error(err);
    }
}

run().catch(console.error);
