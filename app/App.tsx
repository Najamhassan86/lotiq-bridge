/**
 * LotIQ Bridge — camera-provisioning field app (React Native / Expo, dev build).
 *
 * The installer signs in, picks a property, and sees the camera positions the super admin created for
 * it. Tapping "Set up" opens the automatic path: scan the Wi-Fi for cameras (or type an IP), enter the
 * camera's current admin password, and the app configures it end-to-end over the network — Baichuan
 * (port 9000) to log in and open the HTTP port, then CGI to push FTP + time and read it back. No Reolink
 * app. The UID is captured automatically, the position moves to awaiting-footage, and it goes live when
 * its first clip lands. A manual "type the settings into the Reolink app" sheet remains as a fallback.
 *
 * Because it opens a raw TCP socket to the camera, this is a DEV BUILD app (expo-dev-client), not an
 * Expo Go app — see HANDOFF.md for the one-time Apple-account build.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { cognitoLogin, type LoginResult } from './src/backend/cognito.ts';
import { InstallerApi, type PropertyPick, type Position, type InstallSheet } from './src/backend/installerApi.ts';
import { autoConfigureNative } from './src/autoConfigNative.ts';
import { scanForCameras } from './src/discover.ts';

type Screen = 'login' | 'setup' | 'positions';
type RowStatus = 'idle' | 'configured';
interface PositionRow {
  pos: Position;
  status: RowStatus;
  note?: string;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('login');
  const [log, setLog] = useState<string[]>([]);
  const scroll = useRef<ScrollView>(null);
  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-200), line]);
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
  }, []);

  // Session-wide state, set as the operator moves forward.
  const [session, setSession] = useState<LoginResult | null>(null);
  const api = useMemo(() => (session ? new InstallerApi(session.idToken) : null), [session]);
  const [property, setProperty] = useState<PropertyPick | null>(null);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>LotIQ Bridge</Text>
        {session && <Text style={styles.crumb}>{property ? property.name : 'pick a property'}</Text>}
      </View>

      {screen === 'login' && (
        <LoginScreen
          onDone={(res) => {
            setSession(res);
            setScreen('setup');
            append('Signed in.');
          }}
        />
      )}

      {screen === 'setup' && api && (
        <SetupScreen
          api={api}
          property={property}
          setProperty={setProperty}
          onContinue={() => {
            setScreen('positions');
            append(`Working on ${property?.name}.`);
          }}
          log={append}
        />
      )}

      {screen === 'positions' && api && property && (
        <PositionsScreen api={api} property={property} log={append} onBack={() => setScreen('setup')} />
      )}

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

function LoginScreen({ onDone }: { onDone: (r: LoginResult) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      onDone(await cognitoLogin(email, password));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.body}>
      <Text style={styles.h2}>Sign in</Text>
      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!busy}
        placeholder="you@lotiq.pro"
      />
      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        editable={!busy}
        placeholder="••••••••"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={submit}
        disabled={busy || !email || !password}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </TouchableOpacity>
    </View>
  );
}

function SetupScreen({
  api,
  property,
  setProperty,
  onContinue,
  log,
}: {
  api: InstallerApi;
  property: PropertyPick | null;
  setProperty: (p: PropertyPick) => void;
  onContinue: () => void;
  log: (line: string) => void;
}) {
  const [properties, setProperties] = useState<PropertyPick[] | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const list = await api.listProperties();
      setProperties(list);
      log(`Loaded ${list.length} propert${list.length === 1 ? 'y' : 'ies'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load properties');
    } finally {
      setLoading(false);
    }
  };

  // Load the property list once, when this screen first mounts.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = (properties ?? []).filter(
    (p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()) || p.propertyId.includes(filter),
  );

  const start = () => {
    if (property) onContinue();
  };

  return (
    <View style={styles.body}>
      <Text style={styles.h2}>Property</Text>
      <TextInput
        style={styles.input}
        value={filter}
        onChangeText={setFilter}
        placeholder="Search properties"
        autoCapitalize="none"
      />
      <ScrollView style={styles.propList}>
        {loading && <ActivityIndicator style={{ marginTop: 16 }} color="#0B6A73" />}
        {shown.map((p) => {
          const sel = property?.dynamoId === p.dynamoId;
          return (
            <TouchableOpacity key={p.dynamoId} style={[styles.propRow, sel && styles.propRowSel]} onPress={() => setProperty(p)}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.propName, sel && styles.propNameSel]}>{p.name}</Text>
                <Text style={styles.propMeta}>
                  {p.propertyId}
                  {p.hasTimeZone ? '' : '  ·  ⚠ no time zone set'}
                </Text>
              </View>
              {sel ? <Text style={styles.check}>✓</Text> : null}
            </TouchableOpacity>
          );
        })}
        {properties && shown.length === 0 && !loading ? <Text style={styles.propMeta}>No matches.</Text> : null}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity
        style={[styles.button, !property && styles.buttonDisabled]}
        onPress={start}
        disabled={!property}
      >
        <Text style={styles.buttonText}>Continue to positions</Text>
      </TouchableOpacity>
    </View>
  );
}

function PositionsScreen({
  api,
  property,
  log,
  onBack,
}: {
  api: InstallerApi;
  property: PropertyPick;
  log: (line: string) => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sheetPos, setSheetPos] = useState<PositionRow | null>(null);
  const [sheet, setSheet] = useState<InstallSheet | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetUid, setSheetUid] = useState('');
  const [marking, setMarking] = useState(false);
  const [sheetIp, setSheetIp] = useState('');
  const [sheetPwd, setSheetPwd] = useState('');
  const [sheetNewPwd, setSheetNewPwd] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string[]>([]);

  const rowStatusFor = (p: Position): RowStatus =>
    p.boundUid || p.status === 'provisioned' || p.status === 'awaiting_footage' ? 'configured' : 'idle';

  const load = async () => {
    setLoading(true);
    try {
      const positions = await api.listPositions(property.dynamoId);
      setRows(positions.map((pos) => ({ pos, status: rowStatusFor(pos) })));
      log(`Loaded ${positions.length} position(s).`);
    } catch (e) {
      log(`Could not load positions: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  // Load the property's positions when this screen first mounts.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSheet = async (row: PositionRow) => {
    setSheetPos(row);
    setSheet(null);
    setSheetUid('');
    setSheetIp('');
    setSheetPwd('');
    setSheetNewPwd('');
    setFound([]);
    setShowManual(false);
    setSheetLoading(true);
    try {
      setSheet(await api.getInstallSheet(row.pos.cameraId));
    } catch (e) {
      log(`Could not build the install sheet: ${e instanceof Error ? e.message : String(e)}`);
      setSheetPos(null);
    } finally {
      setSheetLoading(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setFound([]);
    try {
      const ips = await scanForCameras({
        log,
        onFound: (ip) => setFound((prev) => (prev.includes(ip) ? prev : [...prev, ip])),
      });
      log(ips.length ? `Found ${ips.length} camera(s) on Wi-Fi.` : 'No cameras found (port 9000). Type the IP by hand.');
    } catch (e) {
      log(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const autoConfigureNow = async () => {
    if (!sheetPos) return;
    if (!sheetIp.trim()) {
      log('Enter or scan the camera IP first.');
      return;
    }
    setAutoBusy(true);
    try {
      const steps = await api.getInstallSteps(sheetPos.pos.cameraId);
      log(`Applying ${steps.length} setting(s) to ${sheetIp.trim()}…`);
      const out = await autoConfigureNative({
        ip: sheetIp,
        currentPassword: sheetPwd,
        newPassword: sheetNewPwd.trim() || undefined,
        steps,
        log,
      });
      if (!out.ok) {
        log(`Read-back mismatch — not marking configured: ${out.problems.join('; ')}`);
        return;
      }
      const uid = sheetUid.trim() || out.uid || undefined;
      await api.markConfigured(sheetPos.pos.cameraId, { uid });
      setRows((prev) =>
        prev.map((r) =>
          r.pos.cameraId === sheetPos.pos.cameraId
            ? { ...r, status: 'configured', note: uid ? `auto-configured · ${uid}` : 'auto-configured' }
            : r,
        ),
      );
      log(`✓ ${sheetPos.pos.name} configured over Wi-Fi (HTTP opened via ${out.httpOpenedVia}).`);
      setSheetPos(null);
    } catch (e) {
      log(`Auto setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAutoBusy(false);
    }
  };

  const markConfigured = async () => {
    if (!sheetPos) return;
    setMarking(true);
    try {
      await api.markConfigured(sheetPos.pos.cameraId, { uid: sheetUid.trim() || undefined });
      setRows((prev) =>
        prev.map((r) => (r.pos.cameraId === sheetPos.pos.cameraId ? { ...r, status: 'configured', note: 'awaiting footage' } : r)),
      );
      log(`Marked ${sheetPos.pos.name} configured.`);
      setSheetPos(null);
    } catch (e) {
      log(`Could not mark configured: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMarking(false);
    }
  };

  return (
    <View style={styles.body}>
      <View style={styles.scanHead}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backLink}>‹ Property</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.scanBtn, loading && styles.buttonDisabled]} onPress={load} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Refresh</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.camList}>
        {rows.length === 0 && !loading ? (
          <Text style={styles.propMeta}>No positions yet. Add them on the super-admin portal for this property.</Text>
        ) : null}
        {rows.map((r) => (
          <View key={r.pos.cameraId} style={styles.camRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.camUid}>
                {r.pos.positionNo != null ? `#${r.pos.positionNo} · ` : ''}
                {r.pos.name}
              </Text>
              <Text style={styles.propMeta}>
                {[r.pos.lotId, r.pos.intendedModel].filter(Boolean).join(' · ') || r.pos.cameraSlug}
                {r.note ? ` · ${r.note}` : ''}
              </Text>
            </View>
            {r.status === 'configured' ? (
              <Text style={styles.badgeDone}>✓ set up</Text>
            ) : !r.pos.ready ? (
              <Text style={styles.badgeKnown}>no profile</Text>
            ) : (
              <TouchableOpacity style={styles.provBtn} onPress={() => openSheet(r)}>
                <Text style={styles.provBtnText}>Set up</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>

      <Modal visible={sheetPos !== null} animationType="slide" transparent onRequestClose={() => setSheetPos(null)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.sheetTitle}>Set up “{sheetPos?.pos.name}”</Text>
            <Text style={styles.sheetHint}>
              Be on the same Wi-Fi as the camera. Scan or type its IP, enter the current admin password, and the app
              opens the camera's HTTP port and configures FTP + time over the network — no Reolink app.
            </Text>

            <ScrollView style={{ maxHeight: 420 }}>
              <Text style={styles.sheetSection}>Automatic (over Wi-Fi)</Text>

              <View style={styles.scanFindRow}>
                <Text style={styles.label}>Camera IP address</Text>
                <TouchableOpacity onPress={runScan} disabled={scanning}>
                  <Text style={[styles.backLink, scanning && styles.buttonDisabled]}>
                    {scanning ? 'Scanning…' : 'Scan Wi-Fi'}
                  </Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={sheetIp}
                onChangeText={setSheetIp}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="e.g. 192.168.1.64"
              />
              {found.length > 0 ? (
                <View style={styles.foundBox}>
                  {found.map((ip) => (
                    <TouchableOpacity
                      key={ip}
                      style={[styles.foundRow, sheetIp === ip && styles.foundRowSel]}
                      onPress={() => setSheetIp(ip)}
                    >
                      <Text style={[styles.foundIp, sheetIp === ip && styles.propNameSel]}>{ip}</Text>
                      {sheetIp === ip ? <Text style={styles.check}>✓</Text> : null}
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              <Text style={styles.label}>Current admin password</Text>
              <TextInput
                style={styles.input}
                value={sheetPwd}
                onChangeText={setSheetPwd}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="the camera's admin password now"
              />
              <Text style={styles.label}>New admin password (optional — rotate)</Text>
              <TextInput
                style={styles.input}
                value={sheetNewPwd}
                onChangeText={setSheetNewPwd}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="leave blank to keep the current one"
              />
              <Text style={styles.label}>Camera UID (optional — auto-read if blank)</Text>
              <TextInput
                style={styles.input}
                value={sheetUid}
                onChangeText={setSheetUid}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="read from the camera during setup"
              />
              <TouchableOpacity
                style={[styles.button, (autoBusy || !sheetIp.trim()) && styles.buttonDisabled]}
                onPress={autoConfigureNow}
                disabled={autoBusy || !sheetIp.trim()}
              >
                {autoBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Configure automatically</Text>}
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setShowManual((v) => !v)} style={{ marginTop: 18 }}>
                <Text style={styles.backLink}>{showManual ? '▾ Hide manual settings' : '▸ Or enter these into the Reolink app by hand'}</Text>
              </TouchableOpacity>

              {showManual ? (
                sheetLoading || !sheet ? (
                  <ActivityIndicator style={{ marginVertical: 20 }} color="#0B6A73" />
                ) : (
                  <View style={{ marginTop: 6 }}>
                    <Text style={styles.sheetHint}>Long-press a value to copy.</Text>
                    <Text style={styles.sheetSection}>FTP</Text>
                    <SheetRow label="Server" value={sheet.ftp.server} />
                    <SheetRow label="Port" value={String(sheet.ftp.port)} />
                    <SheetRow label="Username" value={sheet.ftp.username} />
                    <SheetRow label="Password" value={sheet.ftp.password} />
                    <SheetRow label="Mode" value={sheet.ftp.passiveMode ? 'Passive' : 'Active'} />
                    <SheetRow label="Remote directory" value={sheet.ftp.remoteDirectory} />
                    <SheetRow label="Auto sub-folders" value={sheet.ftp.createSubfolders ? 'On' : 'Off'} />
                    <Text style={styles.sheetSection}>Video &amp; schedule</Text>
                    <SheetRow label="Stream" value={sheet.ftp.stream} />
                    <SheetRow label="Max file size" value={`${sheet.ftp.maxFileSizeMb} MB`} />
                    <SheetRow label="Still photo every" value={`${sheet.ftp.stillEverySeconds} s`} />
                    <SheetRow label="Upload" value={sheet.ftp.uploadSchedule} />
                    <Text style={styles.sheetSection}>Time</Text>
                    <SheetRow label="Time zone" value={sheet.time.timeZone} />
                    <TouchableOpacity
                      style={[styles.button, marking && styles.buttonDisabled]}
                      onPress={markConfigured}
                      disabled={marking}
                    >
                      {marking ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Mark configured (manual)</Text>}
                    </TouchableOpacity>
                  </View>
                )
              ) : null}
            </ScrollView>

            <View style={styles.sheetBtns}>
              <TouchableOpacity
                style={[styles.sheetCancel, styles.sheetSave]}
                onPress={() => setSheetPos(null)}
                disabled={autoBusy || marking}
              >
                <Text style={styles.sheetCancelText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SheetRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.sheetRow}>
      <Text style={styles.sheetLabel}>{label}</Text>
      <Text style={styles.sheetValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 60, backgroundColor: '#F3F5F4' },
  header: { paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 24, fontWeight: '700', color: '#15201E' },
  crumb: { fontSize: 12, color: '#56645F', marginTop: 2 },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  h2: { fontSize: 17, fontWeight: '600', color: '#15201E', marginBottom: 8 },
  label: { fontSize: 12, color: '#56645F', marginBottom: 4, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#D3DBD8', borderRadius: 8, padding: 12, backgroundColor: '#fff', fontSize: 15 },
  button: { backgroundColor: '#0B6A73', borderRadius: 8, padding: 15, alignItems: 'center', marginTop: 14 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#B03A2E', fontSize: 13, marginTop: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  switchLabel: { flex: 1, fontSize: 13, color: '#56645F' },
  propList: { maxHeight: 220, marginTop: 8, borderWidth: 1, borderColor: '#E1E7E5', borderRadius: 8, backgroundColor: '#fff' },
  propRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#EEF2F1' },
  propRowSel: { backgroundColor: '#DCEEEF' },
  propName: { fontSize: 15, color: '#15201E', fontWeight: '500' },
  propNameSel: { color: '#0B6A73' },
  scanFindRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 10 },
  foundBox: { marginTop: 8, borderWidth: 1, borderColor: '#E1E7E5', borderRadius: 8, backgroundColor: '#fff', overflow: 'hidden' },
  foundRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderBottomWidth: 1, borderBottomColor: '#EEF2F1' },
  foundRowSel: { backgroundColor: '#DCEEEF' },
  foundIp: { fontSize: 14, color: '#15201E', fontFamily: 'Courier' },
  propMeta: { fontSize: 12, color: '#7B8783', marginTop: 2 },
  check: { color: '#0B6A73', fontSize: 18, fontWeight: '700' },
  scanHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  backLink: { color: '#0B6A73', fontSize: 15, fontWeight: '600' },
  scanBtn: { backgroundColor: '#0B6A73', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 22, alignItems: 'center' },
  camList: { flex: 1, marginTop: 6 },
  camRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E1E7E5' },
  camUid: { fontSize: 15, fontWeight: '600', color: '#15201E', fontFamily: 'Courier' },
  provBtn: { backgroundColor: '#0B6A73', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14 },
  provBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  badgeKnown: { color: '#7B8783', fontSize: 13, fontWeight: '600' },
  badgeDone: { color: '#2E7A4B', fontSize: 14, fontWeight: '700' },
  badgeFail: { color: '#B03A2E', fontSize: 13, fontWeight: '700' },
  logBox: { maxHeight: 150, marginHorizontal: 20, marginBottom: 24, marginTop: 8, backgroundColor: '#E7ECEA', borderRadius: 8, padding: 10 },
  logLine: { fontFamily: 'Courier', fontSize: 11, color: '#15201E' },
  modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  modalCard: { backgroundColor: '#F3F5F4', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, paddingBottom: 34 },
  sheetTitle: { fontSize: 19, fontWeight: '700', color: '#15201E' },
  sheetHint: { fontSize: 13, color: '#56645F', marginTop: 4, marginBottom: 8 },
  sheetSection: { fontSize: 12, fontWeight: '700', color: '#0B6A73', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 12, marginBottom: 2 },
  sheetRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#E1E7E5', gap: 10 },
  sheetLabel: { width: 130, fontSize: 13, color: '#56645F' },
  sheetValue: { flex: 1, fontSize: 14, color: '#15201E', fontFamily: 'Courier', fontWeight: '600' },
  sheetBtns: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  sheetCancel: { paddingVertical: 15, paddingHorizontal: 18, borderRadius: 8, backgroundColor: '#E7ECEA' },
  sheetCancelText: { color: '#56645F', fontWeight: '600', fontSize: 15 },
  sheetSave: { flex: 1, marginTop: 0 },
});
