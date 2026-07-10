import 'dart:convert';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:logger/logger.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

/// Firebase kimlik doğrulama: anonim giriş (sürtünmesiz) + opsiyonel Google bağlama.
/// Kullanıcı hiçbir şey yapmadan anonim bir kimlik alır; isterse Google ile
/// hesabını kalıcı hale getirip cihaz değişse de verisine erişebilir.
class AuthService {
  final FirebaseAuth _auth;
  final Logger _logger = Logger();

  AuthService({FirebaseAuth? auth}) : _auth = auth ?? FirebaseAuth.instance;

  User? get currentUser => _auth.currentUser;
  String? get uid => _auth.currentUser?.uid;
  bool get isSignedIn => _auth.currentUser != null;
  bool get isAnonymous => _auth.currentUser?.isAnonymous ?? true;
  Stream<User?> authStateChanges() => _auth.authStateChanges();

  /// Uygulama açılışında çağrılır: oturum yoksa anonim oturum açar.
  Future<User?> ensureSignedIn() async {
    if (_auth.currentUser != null) return _auth.currentUser;
    try {
      final cred = await _auth.signInAnonymously();
      _logger.i('Anonim oturum açıldı: ${cred.user?.uid}');
      return cred.user;
    } catch (e) {
      _logger.e('Anonim giriş hatası: $e');
      return null;
    }
  }

  /// Anonim hesabı Google hesabına yükseltir (veriyi kaybetmeden).
  /// Zaten Google'a bağlıysa veya farklı durumda normal Google girişi yapar.
  Future<User?> linkWithGoogle() async {
    try {
      // google_sign_in v7: instance + initialize + authenticate akışı
      final signIn = GoogleSignIn.instance;
      await signIn.initialize();
      final googleUser = await signIn.authenticate();
      final idToken = googleUser.authentication.idToken;
      if (idToken == null) return null;
      final credential = GoogleAuthProvider.credential(idToken: idToken);

      final current = _auth.currentUser;
      if (current != null && current.isAnonymous) {
        // Anonim hesabı Google'a yükselt — UID korunur, veri kaybolmaz
        try {
          final linked = await current.linkWithCredential(credential);
          _logger.i('Anonim hesap Google ile bağlandı: ${linked.user?.uid}');
          return linked.user;
        } on FirebaseAuthException catch (e) {
          if (e.code == 'credential-already-in-use') {
            // Bu Google hesabı zaten var — o hesaba giriş yap
            final signed = await _auth.signInWithCredential(credential);
            _logger.i('Mevcut Google hesabına giriş: ${signed.user?.uid}');
            return signed.user;
          }
          rethrow;
        }
      } else {
        final signed = await _auth.signInWithCredential(credential);
        return signed.user;
      }
    } catch (e) {
      _logger.e('Google bağlama hatası: $e');
      return null;
    }
  }

  /// Anonim hesabı Apple hesabına yükseltir (veriyi kaybetmeden).
  /// Zaten Apple'a bağlıysa veya farklı durumda normal Apple girişi yapar.
  Future<User?> linkWithApple() async {
    try {
      final rawNonce = _generateNonce();
      final nonce = sha256.convert(utf8.encode(rawNonce)).toString();
      final appleCred = await SignInWithApple.getAppleIDCredential(
        scopes: [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
        nonce: nonce,
      );
      final credential = OAuthProvider('apple.com').credential(
        idToken: appleCred.identityToken,
        rawNonce: rawNonce,
        accessToken: appleCred.authorizationCode,
      );

      final current = _auth.currentUser;
      if (current != null && current.isAnonymous) {
        // Anonim hesabı Apple'a yükselt — UID korunur, veri kaybolmaz
        try {
          final linked = await current.linkWithCredential(credential);
          _logger.i('Anonim hesap Apple ile bağlandı: ${linked.user?.uid}');
          return linked.user;
        } on FirebaseAuthException catch (e) {
          if (e.code == 'credential-already-in-use') {
            // Bu Apple hesabı zaten var — o hesaba giriş yap
            final signed = await _auth.signInWithCredential(credential);
            _logger.i('Mevcut Apple hesabına giriş: ${signed.user?.uid}');
            return signed.user;
          }
          rethrow;
        }
      } else {
        final signed = await _auth.signInWithCredential(credential);
        return signed.user;
      }
    } catch (e) {
      _logger.e('Apple bağlama hatası: $e');
      return null;
    }
  }

  /// Apple'ın nonce (replay-attack koruması) için rastgele bir dize üretir.
  String _generateNonce([int length = 32]) {
    const charset =
        '0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._';
    final random = Random.secure();
    return List.generate(length, (_) => charset[random.nextInt(charset.length)])
        .join();
  }

  Future<void> signOut() async {
    try {
      await GoogleSignIn.instance.signOut();
    } catch (_) {}
    await _auth.signOut();
  }
}
