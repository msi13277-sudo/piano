// 피아노 입력: 블루투스 MIDI(Web Bluetooth)와 USB/시스템 MIDI(Web MIDI).
// 두 경로 모두 onMessage(status, data1, data2)로 MIDI 메시지를 전달한다.

const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b51-8a14-27a3dd2e2d5c';
const BLE_MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

function dataLength(status) {
  const cmd = status & 0xf0;
  if (cmd === 0xc0 || cmd === 0xd0) return 1;
  if (cmd === 0xf0) {
    if (status === 0xf1 || status === 0xf3) return 1;
    if (status === 0xf2) return 2;
    return 0;
  }
  return 2;
}

// BLE MIDI 패킷: [헤더][타임스탬프][상태][데이터...] 가 반복되며,
// 상태 바이트가 생략되는 러닝 스테이터스도 올 수 있다.
export function parseBleMidi(view, onMessage) {
  let i = 1; // 0번 바이트는 헤더
  let status = 0;
  let inSysex = false;
  const len = view.byteLength;

  while (i < len) {
    let b = view.getUint8(i);

    if (inSysex) {
      if (b === 0xf7) inSysex = false;
      i++;
      continue;
    }

    if (b & 0x80) {
      i++; // 타임스탬프
      if (i >= len) break;
      b = view.getUint8(i);
      if (b & 0x80) {
        if (b === 0xf0) {
          inSysex = true;
          i++;
          continue;
        }
        if (b >= 0xf8) {
          i++; // 리얼타임 메시지는 러닝 스테이터스를 바꾸지 않는다
          continue;
        }
        status = b;
        i++;
      }
    }

    if (!status) {
      i++;
      continue;
    }

    const need = dataLength(status);
    if (i + need > len) break;
    const d1 = need > 0 ? view.getUint8(i) : 0;
    const d2 = need > 1 ? view.getUint8(i + 1) : 0;
    // 데이터 자리에 상태/타임스탬프 바이트가 오면 그 위치부터 다시 해석한다.
    if (d1 & 0x80) continue;
    if (d2 & 0x80) {
      i += 1;
      continue;
    }
    i += need;
    onMessage(status, d1, d2);
    if (need === 0) status = 0;
  }
}

export function bluetoothSupported() {
  return 'bluetooth' in navigator;
}

export function webMidiSupported() {
  return 'requestMIDIAccess' in navigator;
}

// 피아노에 따라 검색 신호에 MIDI 서비스 표시를 넣지 않는 경우가 있어서
// 이름으로도 찾고, showAll이면 주변의 모든 기기를 보여준다.
export async function connectBluetooth(onMessage, onState, showAll = false) {
  const device = await navigator.bluetooth.requestDevice(
    showAll
      ? { acceptAllDevices: true, optionalServices: [BLE_MIDI_SERVICE] }
      : {
          filters: [
            { services: [BLE_MIDI_SERVICE] },
            { namePrefix: 'FP' },
            { namePrefix: 'Roland' },
          ],
          optionalServices: [BLE_MIDI_SERVICE],
        }
  );
  const name = device.name || '블루투스 피아노';

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 블루투스 연결 직후에는 서비스 조회나 알림 설정이 실패하는 일이 흔해서
  // (특히 첫 연결에서 기기 간 인증이 진행되는 동안) 몇 번 다시 시도한다.
  const attach = async () => {
    onState({ connected: false, name, reconnecting: true });
    let lastError = null;
    let stage = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        stage = '피아노 접속';
        if (!device.gatt.connected) await device.gatt.connect();
        stage = 'MIDI 서비스 찾기';
        const service = await device.gatt.getPrimaryService(BLE_MIDI_SERVICE);
        stage = 'MIDI 채널 찾기';
        const characteristic = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);
        characteristic.oncharacteristicvaluechanged = (event) => {
          parseBleMidi(event.target.value, onMessage);
        };
        stage = '건반 신호 받기 설정';
        await characteristic.startNotifications();
        try {
          await characteristic.readValue(); // 일부 기기는 한 번 읽어야 신호를 보내기 시작한다
        } catch {
          // 읽기를 지원하지 않아도 문제없다
        }
        onState({ connected: true, name });
        return;
      } catch (error) {
        lastError = error;
        await pause(1500);
      }
    }
    onState({ connected: false, name });
    const failure = new Error(`${stage} 단계에서 실패: ${lastError.message}`);
    failure.name = lastError.name;
    throw failure;
  };

  let busy = false;
  const guardedAttach = async () => {
    if (busy) return;
    busy = true;
    try {
      await attach();
    } finally {
      busy = false;
    }
  };

  device.addEventListener('gattserverdisconnected', () => {
    guardedAttach().catch(() => {});
  });

  await guardedAttach();
}

export async function connectWebMidi(onMessage, onState) {
  const access = await navigator.requestMIDIAccess();

  const refresh = () => {
    const names = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = (event) => {
        const [status, d1 = 0, d2 = 0] = event.data;
        if (status < 0xf0) onMessage(status, d1, d2);
      };
      names.push(input.name);
    }
    onState({ connected: names.length > 0, name: names.join(', ') });
    return names.length;
  };

  access.onstatechange = refresh;
  return refresh();
}
