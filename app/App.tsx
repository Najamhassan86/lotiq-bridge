/**
 * LotIQ Bridge — field app (React Native / Expo).
 *
 * One screen: enter the backend URL and the 6-digit pairing code from the portal, tap Start, and the
 * app pairs, polls for jobs and runs them against cameras on the local network, showing each step go
 * green. All provisioning logic is in `src/bridge` (typechecked + tested in CI); this is UI + glue.
 *
 * "Simulate camera" runs jobs against an in-memory FakeReolink so the phone↔backend path can be
 * tested without a camera on the LAN — a good first TestFlight build. Turn it off for real hardware,
 * which uses ReolinkDriver over the native TCP socket (src/rnSocket.ts).
 *
 * iOS: the first socket connect triggers the local-network permission prompt; if denied, discovery
 * silently finds nothing. Info.plist must carry NSLocalNetworkUsageDescription and
 * NSAllowsLocalNetworking (set via app.json → ios.infoPlist).
 */
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { FakeReolink, ReolinkDriver, runBridge, type ProvisionJob } from './src/bridge/index.ts';
import { rnSocketFactory } from './src/rnSocket.ts';

const DEFAULT_URL = 'https://etafooe4n9.execute-api.us-east-1.amazonaws.com';

export default function App() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [code, setCode] = useState('');
  const [subnet, setSubnet] = useState('');
  const [simulate, setSimulate] = useState(true);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const scroll = useRef<ScrollView>(null);

  const append = (line: string) => {
    setLog((prev) => [...prev, line]);
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
  };

  const start = async () => {
    if (!url.trim() || code.trim().length !== 6) {
      append('Enter the backend URL and the 6-digit pairing code.');
      return;
    }
    setRunning(true);
    setLog([]);
    await activateKeepAwakeAsync('bridge');
    try {
      const summary = await runBridge({
        baseUrl: url.trim(),
        pairCode: code.trim(),
        subnet: subnet.trim() || undefined,
        platform: 'ios',
        appVersion: '0.1.0',
        maxIdlePolls: simulate ? 4 : 0,
        log: append,
        makeDriver: async (job: ProvisionJob) => {
          const uid = job.uid ?? '';
          if (simulate) return new FakeReolink({ uid: uid || 'SIMUID' });
          // Real path: the camera IP is found by UID via a LAN sweep (native socket); here we assume
          // the payload carries it, else discovery must run first. Kept simple for the first build.
          const ip = (job.payload?.ip as string) ?? '';
          if (!ip) throw new Error('real-camera discovery not wired yet — use Simulate for now');
          return new ReolinkDriver(ip, rnSocketFactory, { model: '', firmware: '' });
        },
      });
      append(`Done — ran ${summary.ran.length} job(s).`);
    } catch (e) {
      append(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      deactivateKeepAwake('bridge');
      setRunning(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>LotIQ Bridge</Text>
      <Text style={styles.label}>Backend URL</Text>
      <TextInput style={styles.input} value={url} onChangeText={setUrl} editable={!running} autoCapitalize="none" />
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.label}>Pairing code</Text>
          <TextInput
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={setCode}
            editable={!running}
            keyboardType="number-pad"
            maxLength={6}
          />
        </View>
        <View style={styles.flex}>
          <Text style={styles.label}>Subnet (optional)</Text>
          <TextInput
            style={styles.input}
            value={subnet}
            onChangeText={setSubnet}
            editable={!running}
            placeholder="192.168.1"
            autoCapitalize="none"
          />
        </View>
      </View>
      <View style={styles.switchRow}>
        <Switch value={simulate} onValueChange={setSimulate} disabled={running} />
        <Text style={styles.switchLabel}>Simulate camera (test phone → backend with no real camera)</Text>
      </View>
      <TouchableOpacity style={[styles.button, running && styles.buttonDisabled]} onPress={start} disabled={running}>
        {running ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Start install session</Text>}
      </TouchableOpacity>
      <ScrollView ref={scroll} style={styles.logBox}>
        {log.map((line, i) => (
          <Text key={i} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 20, paddingTop: 64, backgroundColor: '#F3F5F4' },
  title: { fontSize: 26, fontWeight: '700', color: '#15201E', marginBottom: 16 },
  label: { fontSize: 12, color: '#56645F', marginBottom: 4, marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#D3DBD8', borderRadius: 8, padding: 12, backgroundColor: '#fff', fontSize: 15 },
  code: { fontSize: 22, letterSpacing: 6 },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  switchLabel: { flex: 1, fontSize: 13, color: '#56645F' },
  button: { backgroundColor: '#0B6A73', borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 16 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  logBox: { flex: 1, marginTop: 16, backgroundColor: '#E7ECEA', borderRadius: 8, padding: 10 },
  logLine: { fontFamily: 'Courier', fontSize: 12, color: '#15201E' },
});
