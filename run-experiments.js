const puppeteer = require('puppeteer');
const { createObjectCsvWriter } = require('csv-writer');
const pidusage = require('pidusage');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

// --- Configuration ---
const TEST_DURATION_S = 30; // How long each test runs
const SAMPLING_INTERVAL_MS = 1000; // How often to collect data
const P2P_URL = 'http://localhost:3000/p2p';
const INTERFACE_NAME = 'wlan0'; // Your network interface

const EXPERIMENTS = [
    { arch: 'P2P', viewers: 1, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 3, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 5, loss: 0, bw: 0 },
    { arch: 'P2P', viewers: 5, loss: 2, bw: 0 },
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
        if (stderr && !stderr.includes('Cannot delete qdisc')) {
            console.error(`Error executing command: ${stderr}`);
        }
        return stdout;
    } catch (error) {
        if (error.stderr && !error.stderr.includes('Cannot delete qdisc')) {
            console.warn(`Warning executing command: ${error.stderr}`);
        }
    }
}

async function setNetworkConditions(loss, bw) {
    console.log('[Step 1] Setting network conditions...');
    await runCommand(`sudo tc qdisc del dev ${INTERFACE_NAME} root`);
    if (loss > 0 || bw > 0) {
        let command;
        if (bw > 0) {
            command = `sudo tc qdisc add dev ${INTERFACE_NAME} root handle 1: tbf rate ${bw}kbit buffer 1600 limit 3000; sudo tc qdisc add dev ${INTERFACE_NAME} parent 1:1 handle 10: netem loss ${loss}%`;
            console.log(`[Step 1] Applying ${loss}% packet loss AND ${bw}kbps bandwidth cap.`);
        } else {
            command = `sudo tc qdisc add dev ${INTERFACE_NAME} root handle 1: netem loss ${loss}%`;
            console.log(`[Step 1] Applying ${loss}% packet loss.`);
        }
        await runCommand(command);
    } else {
        console.log('[Step 1] Network conditions are at default.');
    }
}

async function runTest({ arch, viewers, loss, bw }) {
    console.log(`\n--- Starting Test: ${arch}, ${viewers} viewers, ${loss}% loss, ${bw}kbps cap ---`);
    await setNetworkConditions(loss, bw);

    console.log('[Step 2] Launching browser...');
    const browser = await puppeteer.launch({
        headless: false,
        timeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream', // Use a fake device instead of trying to capture a real one
            '--auto-select-desktop-capture-source=Entire screen', // Fallback for some versions
        ]
    });

    try {
        console.log('[Step 3] Launching presenter page...');
        const presenterPage = await browser.newPage();
        presenterPage.on('console', msg => console.log(`[PRESENTER BROWSER] ${msg.text()}`));
        presenterPage.on('pageerror', err => console.error(`[PRESENTER BROWSER PAGE ERROR] ${err.toString()}`));

        await presenterPage.goto(P2P_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await presenterPage.waitForSelector('#start-share', { timeout: 60000 });
        const presenterPID = browser.process().pid;
        console.log('[Step 3] Presenter page loaded.');

        const viewerPages = [];
        console.log(`[Step 4] Launching ${viewers} viewer page(s)...`);
        for (let i = 0; i < viewers; i++) {
            const page = await browser.newPage();
            page.on('console', msg => console.log(`[VIEWER ${i+1} BROWSER] ${msg.text()}`));
            page.on('pageerror', err => console.error(`[VIEWER ${i+1} BROWSER PAGE ERROR] ${err.toString()}`));
            await page.goto(P2P_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            viewerPages.push(page);
        }
        console.log('[Step 4] All viewer pages loaded.');
        
        console.log('[Step 5] Clicking start-share button...');
        await presenterPage.click('#start-share');
        // Add a check to see if sharing has started on the page
        await presenterPage.waitForFunction('window.isSharing === true', { timeout: 10000 });
        console.log('[Step 5] Share started. Waiting 5 seconds for connections...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log(`[Step 6] Starting data collection for ${TEST_DURATION_S} seconds...`);
        const collectedData = [];
        const interval = setInterval(async () => {
            try {
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
                // Ignore sampling errors if a page closes prematurely
            }
        }, SAMPLING_INTERVAL_MS);

        await new Promise(resolve => setTimeout(resolve, TEST_DURATION_S * 1000));
        
        clearInterval(interval);
        console.log('[Step 7] Writing data to CSV...');
        await csvWriter.writeRecords(collectedData);

    } catch (error) {
        console.error("An error occurred during the test run:", error);
    } finally {
        console.log('[Step 8] Closing browser...');
        if (browser) await browser.close();
        console.log('--- Test Finished ---');
    }
}

async function main() {
    for (const experiment of EXPERIMENTS) {
        await runTest(experiment);
    }
    console.log('\nAll experiments completed.');
    await runCommand(`sudo tc qdisc del dev ${INTERFACE_NAME} root`);
}

main();
