let scanner = null;
let activeElementId = null;

/**
 * 開啟相機掃描 QR code / 條碼。onDecode 收到內容後由呼叫端決定行為。
 * 掃描器一次只會有一個實例，切換畫面時請呼叫 stopScan()。
 */
export async function startScan(elementId, onDecode, onError) {
  await stopScan();
  activeElementId = elementId;
  scanner = new Html5Qrcode(elementId, { verbose: false });

  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 200, height: 200 } },
      text => onDecode(text),
      () => {} // 每幀掃不到不算錯誤
    );
  } catch (err) {
    scanner = null;
    activeElementId = null;
    onError?.(err);
  }
}

export async function stopScan() {
  if (!scanner) return;
  try {
    await scanner.stop();
    scanner.clear();
  } catch {
    // 已停止或相機已釋放
  }
  if (activeElementId) document.getElementById(activeElementId).innerHTML = '';
  scanner = null;
  activeElementId = null;
}

export const isScanning = () => scanner !== null;
