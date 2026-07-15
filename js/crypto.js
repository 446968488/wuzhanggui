// 加密层：基于 crypto-js 的 AES 与 SHA256（纯前端，file:// 可用）
const Crypto = (function () {
  function encrypt(plainText, pass) {
    return CryptoJS.AES.encrypt(String(plainText), pass).toString();
  }
  function decrypt(cipher, pass) {
    try {
      const bytes = CryptoJS.AES.decrypt(cipher, pass);
      const text = bytes.toString(CryptoJS.enc.Utf8);
      return text || null;
    } catch (e) {
      return null;
    }
  }
  function sha256(str) {
    return CryptoJS.SHA256(String(str)).toString();
  }
  return { encrypt, decrypt, sha256 };
})();
