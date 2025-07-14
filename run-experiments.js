const puppeteer = require('puppeteer');
const { createObjectCsvWriter } = require('csv-writer');
const pidusage = require('pidusage');
const { exec } = require('child_process'); // Use the built-in module
const util = require('util');

// Turn exec into a Promise-based function
const execPromise = util.promisify(exec);

// --- Configuration ---
const TEST_DURATION_S = 30;
const SAMPLING_INTERVAL_MS = 1000;
const P2P_URL = 'http://localhost:3000/p2p';
const INTERFACE_NAME = 'wlan0'; // Your network interface

const EXPERIMENTS = [
    { arch: 'P2P', viewers: 1, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 3, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 5, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 5, loss: 2, bw: 0 }, // 2% loss
    { arch: 'P2P', viewers: 5, loss: 0, bw: 1000 }, // 1000 kbit/s bandwidth cap
];

const csvWriter = createObjectCsvWriter({
    path: `results-${new Date().toISOString().replace(/:/g, '-')}.csv`,
    header: [
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'arch', title: 'Architecture' },
        { id: 'viewers', title: 'Viewers' },
        { id: 'loss', title: 'PacketLoss_Percent' },
        { id: 'bw', title: 'BandwidthCap_kbps' },
        { id: 'cpu', title: 'CPU_Percent' },
        { id: 'latency', title: 'Latency_ms' },
    ],
});

async function runCommand(command) {
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stderr && !stderr.includes('Cannot delete qdisc')) { // Ignore the "ok" error
            console.error(`Error executing command: ${stderr}`);
        }
        return stdout;
    } catch (error) {
        // This catch block will handle errors like "RTNETLINK answers: No such file or directory"
        // which happens when deleting a non-existent rule. We can safely ignore it.
        if (!error.stderr.includes('Cannot delete qdisc')) {
            console.warn(`Warning executing command: ${error.stderr}`);
        }
    }
}

async function setNetworkConditions(loss, bw) {
    console.log('Setting network conditions...');
    await runCommand(`sudo tc qdisc del dev ${INTERFACE_NAME} root`);

    // We need to re-add the root qdisc before adding children rules like tbf and netem
    if (loss > 0 || bw > 0) {
        let command = `sudo tc qdisc add dev ${INTERFACE_NAME} root handle 1: netem loss ${loss}%`;
        if (bw > 0) {
            // Netem must be the "child" of TBF for both to work together
            command = `sudo tc qdisc add dev ${INTERFACE_NAME} root handle 1: tbf rate ${bw}kbit buffer 1600 limit 3000; sudo tc qdisc add dev ${INTERFACE_NAME} parent 1:1 handle 10: netem loss ${loss}%`;
            console.log(`Applying ${loss}% packet loss AND ${bw}kbps bandwidth cap.`);
        } else {
            console.log(`Applying ${loss}% packet loss.`);
        }
        await runCommand(command);
    } else {
        console.log('Network conditions are at default (no loss, no cap).');
    }
}


async function runTest({ arch, viewers, loss, bw }) {
    console.log(`\n--- Starting Test: ${arch}, ${viewers} viewers, ${loss}% loss, ${bw}kbps cap ---`);
    await setNetworkConditions(loss, bw);

    const browser = await puppeteer.launch({ headless: true });
    const presenterPage = await browser.newPage();
    const viewerPages = [];

    // Launch Presenter
    await presenterPage.goto(P2P_URL, { waitUntil: 'domcontentloaded' });
    await presenterPage.waitForSelector('#start-share');
    const presenterPID = browser.process().pid;

    // Launch Viewers
    for (let i = 0; i < viewers; i++) {
        const page = await browser.newPage();
        await page.goto(P2P_URL, { waitUntil: 'domcontentloaded' });
        viewerPages.push(page);
    }
    
    await presenterPage.click('#start-share');
    console.log('Presenter has started sharing. Waiting for connections...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log(`Running test for ${TEST_DURATION_S} seconds...`);
    const collectedData = [];
    const interval = setInterval(async () => {
        try {
            // Ensure there is at least one viewer page to evaluate
            const latencyPromise = viewerPages.length > 0 
                ? viewerPages[0].evaluate(() => window.currentLatency || 0)
                : Promise.resolve(0);

            const [cpuStats, latency] = await Promise.all([
                pidusage(presenterPID),
                latencyPromise,
            ]);

            const record = {
                timestamp: new Date().toLocaleTimeString(),
                arch, viewers, loss, bw,
                cpu: cpuStats.cpu.toFixed(2),
                latency: latency.toFixed(0),
            };
            console.log(record);
            collectedData.push(record);
        } catch(e) {
            console.error('Error during sampling:', e);
        }
    }, SAMPLING_INTERVAL_MS);

    await new Promise(resolve => setTimeout(resolve, TEST_DURATION_S * 1000));
    
    clearInterval(interval);
    await browser.close();
    await csvWriter.writeRecords(collectedData);
    console.log('--- Test Finished ---');
}

async function main() {
    for (const experiment of EXPERIMENTS) {
        await runTest(experiment);
    }
    console.log('\nAll experiments completed.');
    // Reset network to default state after all tests
    await runCommand(`sudo tc qdisc del dev ${INTERFACE_NAME} root`);
}

main();