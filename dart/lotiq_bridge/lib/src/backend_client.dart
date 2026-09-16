/// BridgeBackendClient — the bridge's view of the LotIQ backend (`/api/v1/provision-bridge/*`).
///
/// Port of `../reference/lib/backendClient.mjs`. Outbound only: pair with a code, then poll for jobs
/// and report progress. Session/job ids contain `#`, so every id in a path is percent-encoded.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

class BridgeException implements Exception {
  final int status;
  final String message;
  final dynamic body;
  BridgeException(this.status, this.message, [this.body]);
  @override
  String toString() => 'BridgeException($status): $message';
}

/// The subset of the backend a running job talks to. Extracted so the job runner can be tested
/// against a fake without any network.
abstract interface class BridgeJobApi {
  Future<void> heartbeat(String jobId, {bool running});
  Future<void> postEvents(String jobId, List<Map<String, dynamic>> events);
  Future<void> passwordCommitted(String jobId);
  Future<Map<String, dynamic>> complete(String jobId, Map<String, dynamic> body);
}

class BridgeBackendClient implements BridgeJobApi {
  final String baseUrl;
  final http.Client _client;
  String? token;

  BridgeBackendClient(String baseUrl, {http.Client? client})
      : baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
        _client = client ?? http.Client();

  Future<Map<String, dynamic>> _call(String path,
      {Map<String, dynamic>? body, bool auth = true}) async {
    final headers = <String, String>{'content-type': 'application/json'};
    if (auth) {
      if (token == null) throw StateError('bridge is not paired (no token)');
      headers['authorization'] = 'Bearer $token';
    }
    final res = await _client.post(Uri.parse('$baseUrl$path'),
        headers: headers, body: body == null ? null : jsonEncode(body));
    Map<String, dynamic> json;
    try {
      json = res.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      json = {'raw': res.body};
    }
    if (res.statusCode >= 400) {
      throw BridgeException(
          res.statusCode, json['error']?.toString() ?? 'HTTP ${res.statusCode}', json);
    }
    return json;
  }

  /// Redeem a pairing code; stores the returned bearer token for later calls.
  Future<Map<String, dynamic>> pair(String pairCode,
      {String? platform, String? appVersion, String? subnet}) async {
    final out = await _call('/api/v1/provision-bridge/pair', auth: false, body: {
      'pairCode': pairCode,
      'platform': platform,
      'appVersion': appVersion,
      'subnet': subnet,
    });
    token = out['token'] as String?;
    return out;
  }

  /// Claim the next job, or `{job: null}` when the queue is empty.
  Future<Map<String, dynamic>> nextJob({String? subnet}) =>
      _call('/api/v1/provision-bridge/jobs/next', body: {'subnet': subnet});

  @override
  Future<void> heartbeat(String jobId, {bool running = false}) async {
    await _call('/api/v1/provision-bridge/jobs/${Uri.encodeComponent(jobId)}/heartbeat',
        body: {'running': running});
  }

  @override
  Future<void> postEvents(String jobId, List<Map<String, dynamic>> events) async {
    await _call('/api/v1/provision-bridge/jobs/${Uri.encodeComponent(jobId)}/events',
        body: {'events': events});
  }

  @override
  Future<void> passwordCommitted(String jobId) async {
    await _call(
        '/api/v1/provision-bridge/jobs/${Uri.encodeComponent(jobId)}/password-committed',
        body: {});
  }

  /// Report a job finished. [body] = { status, diff, device, timings, error }.
  @override
  Future<Map<String, dynamic>> complete(String jobId, Map<String, dynamic> body) =>
      _call('/api/v1/provision-bridge/jobs/${Uri.encodeComponent(jobId)}/complete',
          body: body);

  void close() => _client.close();
}
