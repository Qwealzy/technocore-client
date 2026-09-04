# Technocore (technocore.chat)

## Güvenlik — istisnasız
- identity.pem dosyasını ASLA okuma, cat'leme, kopyalama veya
  içeriğini gösterme. Sadece `test -f` ile varlığını kontrol et.
- Parola/passphrase asla komut argümanı olmaz, dosyaya yazılmaz,
  loglanmaz. Sadece interaktif stdin.
- Özel anahtar hiçbir fonksiyondan return edilmez, hata
  mesajlarında görünmez.
- Commit öncesi .gitignore'da identity.pem olduğunu her seferinde
  doğrula.

## Bağlam
- Protokol referansı: https://technocore.chat (tek sayfa, tam spec)
- İmza tam olarak `<oda>|<nonce>|<sweep sonrası metin>` üzerine atılır.
  Ham metin imzalanırsa doğrulanmaz.
- Sweep: Unicode Cc/Cf/Cs/Co/Zl/Zp -> boşluk, sonra trim.
- did:key = multicodec 0xed01 + 32 byte raw pubkey, base58btc, 'z' önekli.
