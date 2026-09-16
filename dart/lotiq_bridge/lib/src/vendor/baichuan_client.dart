/// Baichuan TCP client — direct port of the BC class in bc_prove.py.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:xml/xml.dart';

import 'baichuan_crypto.dart';

const int bcPort = 9000;
const int _chIdHost = 250;
final Uint8List _magic = Uint8List.fromList([0xf0, 0xde, 0xbc, 0x0a]);

class BaichuanAuthException implements Exception {
  final String message;
  BaichuanAuthException(this.message);
  @override
  String toString() => message;
}

class DeviceInfo {
  final String? model, hardwareVersion, firmwareVersion, serialNumber, name;
  DeviceInfo({
    this.model,
    this.hardwareVersion,
    this.firmwareVersion,
    this.serialNumber,
    this.name,
  });
  @override
  String toString() => '$model ($name) fw=$firmwareVersion';
}

class PortState {
  final int port;
  final bool enabled;
  PortState(this.port, this.enabled);
}

class BaichuanClient {
  final String host;
  final int port;
  final String username;
  final String password;

  Socket? _sock;
  StreamSubscription<Uint8List>? _sub;
  final BytesBuilder _buf = BytesBuilder();
  _Pending? _pending;
  Uint8List? _aesKey;
  int _messId = 0;

  BaichuanClient(
    this.host, {
    this.port = bcPort,
    this.username = 'admin',
    this.password = '',
  });

  Future<void> connect({Duration timeout = const Duration(seconds: 8)}) async {
    _sock = await Socket.connect(host, port, timeout: timeout);
    _sub = _sock!.listen(
      _onData,
      onError: (e) => _fail(e),
      onDone: () => _fail(const SocketException('camera closed the connection')),
    );
  }

  Future<void> close() async {
    await _sub?.cancel();
    _sock?.destroy();
    _sock = null;
  }

  void _fail(Object e) {
    final p = _pending;
    _pending = null;
    if (p != null && !p.completer.isCompleted) p.completer.completeError(e);
  }

  // ---------------------------------------------------------------- framing
  Uint8List _header(int cmdId, int messLen, String messageClass,
      {int payloadOffset = 0}) {
    _messId = (_messId + 1) % 16777216;
    final b = BytesBuilder()
      ..add(_magic)
      ..add(_le(cmdId, 4))
      ..add(_le(messLen, 4))
      ..add(_le(_chIdHost, 1))
      ..add(_le(_messId, 3));
    if (messageClass == '1465') {
      b.add(_hex('12dc1465')); // 20-byte header
    } else {
      b
        ..add(_hex('00001464'))
        ..add(_le(payloadOffset, 4)); // 24-byte header
    }
    return b.toBytes();
  }

  static Uint8List _le(int v, int n) {
    final o = Uint8List(n);
    for (var i = 0; i < n; i++) {
      o[i] = (v >> (8 * i)) & 0xFF;
    }
    return o;
  }

  static Uint8List _hex(String h) => Uint8List.fromList(List.generate(
      h.length ~/ 2, (i) => int.parse(h.substring(i * 2, i * 2 + 2), radix: 16)));

  void _onData(Uint8List data) {
    _buf.add(data);

    // A TCP segment can carry several frames, and the camera pushes
    // unsolicited ones after login. Drain the whole buffer each time and
    // only complete on a frame whose cmd_id matches what we asked for.
    while (true) {
      final bytes = _buf.toBytes();
      if (bytes.length < 20) return;

      if (!_eq(bytes.sublist(0, 4), _magic)) {
        _buf.clear();
        _fail(const FormatException('bad magic header'));
        return;
      }

      final recCmdId = _rdLe(bytes, 4, 4);
      final lenBody = _rdLe(bytes, 8, 4);
      final messClass = _hx(bytes, 18, 2);

      int lenHeader;
      if (messClass == '1466') {
        lenHeader = 20;
      } else if (messClass == '1464' || messClass == '0000') {
        lenHeader = 24;
        if (bytes.length < 24) return;
      } else {
        _buf.clear();
        _fail(FormatException('unhandled message class $messClass'));
        return;
      }

      if (bytes.length - lenHeader < lenBody) return; // wait for the rest

      final total = lenHeader + lenBody;
      _buf.clear();
      if (bytes.length > total) _buf.add(bytes.sublist(total));

      final p = _pending;

      if (lenHeader == 24) {
        final status = _rdLe(bytes, 16, 2);
        if (status != 200 && status != 201 && status != 300) {
          if (p != null && recCmdId == p.cmdId) {
            _pending = null;
            p.completer.completeError(status == 401
                ? BaichuanAuthException('401 unauthorized — bad credentials')
                : StateError('camera returned status $status'));
            return;
          }
          continue; // error on a frame we did not ask for — ignore it
        }
      }

      // Not our reply (push notification, late response): discard and keep going.
      if (p == null || recCmdId != p.cmdId) continue;

      _pending = null;
      p.completer.complete(_Frame(
        lenHeader,
        bytes.sublist(0, lenHeader),
        bytes.sublist(lenHeader, total),
      ));
      return;
    }
  }

  String _decrypt(_Frame f) {
    if (f.body.isEmpty) return '';
    final encOffset = f.header[12];
    final encType = _hx(f.header, 16, 2);

    String out;
    if (f.lenHeader == 20 && (encType == '01dd' || encType == '12dd')) {
      out = utf8.decode(bcXor(f.body, encOffset), allowMalformed: true);
    } else if (encType == '00dd') {
      out = utf8.decode(f.body, allowMalformed: true);
    } else {
      out = utf8.decode(aesDecrypt(_aesKey!, f.body), allowMalformed: true);
    }

    if (!out.startsWith('<?xml')) {
      final alt = utf8.decode(bcXor(f.body, encOffset), allowMalformed: true);
      if (alt.startsWith('<?xml')) return alt;
      throw FormatException('decrypt failed: ${out.substring(0, min(20, out.length))}');
    }
    return out;
  }

  Future<String> send(int cmdId,
      {String body = '',
      String messageClass = '1464',
      bool bcEncrypt = false,
      Duration timeout = const Duration(seconds: 10)}) async {
    final bodyBytes = utf8.encode(body);
    Uint8List encBody;
    if (bodyBytes.isEmpty) {
      encBody = Uint8List(0);
    } else if (bcEncrypt) {
      encBody = bcXor(bodyBytes, _chIdHost);
    } else {
      encBody = aesEncrypt(_aesKey!, bodyBytes);
    }

    final pending = _Pending(cmdId, Completer<_Frame>());
    _pending = pending;
    _sock!.add(_header(cmdId, bodyBytes.length, messageClass) + encBody);
    await _sock!.flush();

    final frame = await pending.completer.future.timeout(timeout);
    return _decrypt(frame);
  }

  // ---------------------------------------------------------------- sequence
  Future<String> getNonce() async {
    final mess = await send(1, messageClass: '1465', bcEncrypt: true);
    final nonce = _findText(mess, 'nonce');
    if (nonce == null) throw FormatException('no nonce in response');
    _aesKey = deriveAesKey(nonce, password);
    return nonce;
  }

  Future<void> login() async {
    final nonce = await getNonce();
    final userHash = md5Modern('$username$nonce');
    final passHash = md5Modern('$password$nonce');
    final xml = '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<body>\n<LoginUser version="1.1">\n'
        '<userName>$userHash</userName>\n'
        '<password>$passHash</password>\n'
        '<userVer>1</userVer>\n</LoginUser>\n'
        '<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n'
        '</LoginNet>\n</body>\n';
    // TRAP: the login body is BC-XOR, NOT AES.
    await send(1, body: xml, bcEncrypt: true);
  }

  Future<DeviceInfo> getInfo() async {
    final m = await send(80);
    return DeviceInfo(
      model: _findText(m, 'type'),
      hardwareVersion: _findText(m, 'hardwareVersion'),
      firmwareVersion: _findText(m, 'firmwareVersion'),
      serialNumber: _findText(m, 'serialNumber'),
      name: _findText(m, 'name'),
    );
  }

  /// The stable inventory key — matches the QR on the camera case.
  Future<String?> getUid() async => _findText(await send(114), 'uid');

  Future<Map<String, PortState>> getPorts() async {
    final doc = XmlDocument.parse(await send(37));
    final out = <String, PortState>{};
    for (final proto in doc.rootElement.childElements) {
      final name = proto.name.local.replaceAll('Port', '').toLowerCase();
      int? p;
      bool? en;
      for (final k in proto.childElements) {
        final sub = k.name.local.replaceAll(name, '').toLowerCase();
        final t = k.innerText;
        if (sub == 'port') p = int.tryParse(t);
        if (sub == 'enable') en = t == '1';
      }
      if (p != null || en != null) out[name] = PortState(p ?? 0, en ?? false);
    }
    return out;
  }

  Future<void> setPortEnabled(String name, bool enable) async {
    final tag = '${name[0].toUpperCase()}${name.substring(1)}Port';
    final xml = '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<body><$tag version="1.1"><enable>${enable ? 1 : 0}</enable></$tag></body>';
    await send(36, body: xml);
  }

  // ---------------------------------------------------------------- helpers
  static String? _findText(String xml, String tag) {
    try {
      final d = XmlDocument.parse(xml.trim());
      final e = d.findAllElements(tag);
      return e.isEmpty ? null : e.first.innerText;
    } catch (_) {
      return null;
    }
  }

  static int _rdLe(Uint8List b, int off, int n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v |= b[off + i] << (8 * i);
    }
    return v;
  }

  static String _hx(Uint8List b, int off, int n) => b
      .sublist(off, off + n)
      .map((x) => x.toRadixString(16).padLeft(2, '0'))
      .join();

  static bool _eq(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

class _Pending {
  final int cmdId;
  final Completer<_Frame> completer;
  _Pending(this.cmdId, this.completer);
}

class _Frame {
  final int lenHeader;
  final Uint8List header, body;
  _Frame(this.lenHeader, this.header, this.body);
}
