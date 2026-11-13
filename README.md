# SPECTRUM v2 — Esteganografia espectral de imagem em áudio

Esconde uma imagem dentro de um áudio de forma que ela **apareça no espectrograma**. Há dois jeitos de recuperá-la:

| Modo | O que precisa | O que entrega |
|---|---|---|
| **Análise de espectro** (principal) | Qualquer espectrograma; o daqui é otimizado para isso | A imagem visível no espectro. Não precisa extrair nada. |
| **Extração completa** | O WAV gerado (ou uma cópia sem perdas) | O **arquivo original bit a bit** (verificado por CRC32/SHA-256) e a luminância em resolução nativa |

O áudio continua tocando normalmente. A camada embutida fica abaixo do hospedeiro, num nível configurável (padrão −24 dB), e pode ir para a faixa **ultrassônica (22–46 kHz a 96 kHz)**, onde é inaudível.

> Abra `index.html` direto no navegador (Chrome, Edge ou Firefox). Não precisa de servidor, build nem internet: a fonte do Google é opcional e a página cai para a fonte mono do sistema. Tudo roda localmente.

---

## 1. Plano técnico: escolha da técnica e justificativa

### Análise do código original
O Spectrum v1 (`engine.js`) fazia **síntese aditiva direta**: para cada amostra somava uma cossenoide por linha de pixel. Os problemas encontrados:

1. **Fase idêntica em todas as linhas.** Todas começam em fase 0, o que gera picos enormes (fator de crista alto). A normalização pelo pico esmagava a dinâmica.
2. **Amplitude linear** `(soma·100/765)²`. Espectrogramas mostram dB, então a imagem aparecia "lavada", com só alguns níveis visíveis.
3. **Uma linha sim, outra não** (`yFactor = 2`), sempre de 0 a 20 kHz, sem relação com a resolução da FFT de quem analisa.
4. **Bug de índice.** `pixel_x = floor(x / samplesPerPixel)` passa da largura da imagem quando `numSamples / width` não é inteiro.
5. **Sem hospedeiro, sem extração e sem robustez.** O visualizador usava `fftSize = 1024` (512 bins).

### Arquitetura escolhida: pintura espectral OFDM com camada de fase
Cada pixel vira uma **célula tempo × frequência**: uma senoide exatamente centrada no bin `k` de uma FFT de `N` pontos, durante uma coluna de `L` amostras.

```
s(n) = a · cos(2πk(n − S₀)/N + φ)
a    = 10^(−(1−Y)·DR/20)        # luminância Y → amplitude em dB (fica linear na escala do espectrograma)
φ    = θ_k + 2π·símbolo/M       # θ_k aleatória por linha (fator de crista baixo) + dados PSK
```

- **Síntese por IFFT.** Como `k` é inteiro, a senoide é periódica em N. Basta **uma IFFT por coluna**, repetida em ladrilho, para gerar a coluna inteira. Isso é milhares de vezes mais rápido que a síntese aditiva do v1.
- **Crossfade sin²/cos²** de `T` amostras entre colunas: não há cliques nem linhas verticais. A região plana tem ≥ N amostras.
- **Leitura exata.** Uma DFT **retangular** de N amostras alinhada à região plana é ortogonal a todas as outras células (o mesmo princípio do OFDM). Cada célula é lida sem interferência: `|X| = a·N/2` e `arg X = φ`.
- **Duas camadas no mesmo sinal:**
  - a **magnitude** carrega a imagem, que é o que o olho vê no espectro;
  - a **fase** carrega dados invisíveis (BPSK, QPSK ou 8-PSK), com Reed–Solomon e interleaving. Por ela o arquivo original volta byte a byte, com cor.
- **Carving.** O hospedeiro é removido da banda da imagem por STFT (√Hann, 75% de sobreposição, transição em cosseno). A imagem fica nítida no espectro e a leitura fica quase perfeita.
- **Pré-filtro no decodificador.** Um passa-banda por STFT elimina o hospedeiro fora da banda, cujo vazamento pelos lóbulos laterais da janela retangular dominaria. Só esse passo elevou o PSNR da leitura de 11 para 48 dB nos testes.

Por que não as alternativas:

- **LSB** e **eco** não aparecem no espectro.
- **Pintura STFT com fase aleatória e ISTFT** gera textura ruidosa: a STFT resultante é inconsistente e a leitura não é exata.
- **SSTV** é varredura no tempo, não uma imagem no espectro.

A abordagem OFDM resolve tudo de uma vez: imagem nítida, leitura exata e um canal de dados.

### Robustez
- **Beacon autodescritivo.** São 2 cópias de 4 símbolos DBPSK, diferenciais **em frequência**, com 128 portadoras e FFT de 2048. Uma cópia fica **no início** e outra **no fim** do áudio, então sobrevivem a cortes. Ambas ficam **na base da banda**, porque codecs cortam agudos primeiro. O decodificador o encontra **sem saber nenhum parâmetro**. Um desalinhamento temporal δ gira todos os produtos diferenciais pelo mesmo ângulo `2πδ/N`. Esse ângulo é estimado por `arg(Σz²)/2`, e a palavra de sincronismo de 16 bits resolve a ambiguidade de π. O resultado é o início do símbolo com **precisão de sub-amostra**, mesmo com o áudio cortado ou atrasado. O cabeçalho tem 48 bytes com CRC32: taxa, N, banda, grade, DR, modulação, ECC, semente.
- **Preâmbulo** (2 colunas): estimativa de canal por linha `H_r`, que absorve resíduos de tempo e qualquer equalização.
- **Pilotos** (linhas inferior e superior): correção de ganho e deriva de fase por coluna. Isso permite o **mascaramento adaptativo** (ganho variável por coluna) sem que o decodificador precise saber o ganho.
- **ECC:** Reed–Solomon GF(2⁸) RS(255, 255−nsym), com nsym de 16 a 128 (corrige até 25% de bytes). Tem **rasuras suaves**: bytes cujas células têm baixa confiabilidade são marcados como rasura, o que dobra a capacidade de correção. As rasuras são limitadas a nsym − 8: com nsym rasuras o RS sempre "acha" uma palavra válida, uma falsa correção que foi detectada e eliminada nos testes. A ordem é interleaving por byte entre blocos, depois permutação pseudoaleatória de células e whitening.
- **Perfis** (troca entre contraste visual e robustez dos dados):
  - **Visual máximo:** DR 42 dB, RS 6%.
  - **Equilibrado:** DR 32 dB, RS 13%.
  - **Robusto:** DR 24 dB, RS 25%.

  Células escuras (−DR dB) são as primeiras a se perder com ruído ou codec. Um DR menor deixa os pretos menos pretos e os dados bem mais fortes.

### Capacidade (realista, sem limites artificiais)
A capacidade é limitada pelo **princípio da incerteza**: cada célula ocupa `Δf = fs/N` × `Δt = L/fs`, com `L ≥ N + T + N/8`. Portanto `Δf·Δt ≥ 1,375`.

```
pixels ≈ (banda em Hz) × (duração em s) / (Δf·Δt)
```

O planejador calcula isso em tempo real e:

- escolhe **N automático** (o menor que comporta a altura nativa);
- **mantém a resolução original** sempre que cabe;
- quando não cabe, reduz preservando a proporção, avisa e sugere ajustes concretos: duração mínima, N, largura de banda, 96 kHz.

Exemplos medidos:

| Configuração | Imagem nativa |
|---|---|
| 48 kHz, banda 11–20 kHz, 90 s | 640×480 |
| 96 kHz, banda 22–47 kHz, 140 s | **1024×1024** (PSNR 49 dB, arquivo íntegro, com hospedeiro) |

---

## 2. Como usar

1. **01 · Codificar**
   - Escolha uma imagem (ou uma amostra: padrão de teste, glifo, Mona Lisa, mensagem).
   - Escolha um áudio hospedeiro (ou *gerar trilha demo*, ou nenhum: portadora pura).
   - **Tempo:** escolha a duração da imagem (3, 5, 10, 20, 30 s ou qualquer valor; o padrão é 10 s). Com hospedeiro, escolha também **em que segundo** a imagem começa. Marque *Exportar só o trecho* para gerar um arquivo curto; desmarcado, a música inteira continua no arquivo e a imagem fica só naquele trecho.
   - Ajuste banda, intensidade e contraste espectral. O painel **Capacidade** mostra a resolução que cabe no tempo escolhido e quanto tempo a resolução nativa exigiria.
   - **Executar codificação.** O preview desenha o plano de pintura enquanto codifica e, depois, o espectrograma real da saída.
   - **Baixar.** O formato padrão é **"igual ao original"**, e o arquivo sai do tamanho do original (ver seção 3).
2. **02 · Análise de espectro**: o modo principal de recuperação visual.
   - Carregue qualquer áudio. Se houver assinatura SPv2, ela é detectada e a imagem é **enquadrada automaticamente na proporção correta**.
   - Zoom: `roda` no tempo, `shift + roda` na frequência, arrastar move, duplo clique reseta. Também há sliders de zoom e faixa de frequência em Hz.
   - Cores: Matrix Green, Thermal, Plasma, Classic e Ice. Contraste, brilho e gama são aplicados por LUT, sem recálculo.
   - FFT: de 1024 a 32768, ou auto (ajustada à célula da imagem). Janelas: Hann, Blackman-Harris, Gauss, Hamming e retangular. Escala lin ou log.
   - **Grade alinhada:** mostra a leitura OFDM exata de cada célula, que é a "visão do decodificador".
   - **Cascata ao vivo:** espectrograma em tempo real (AnalyserNode) durante a reprodução. A rolagem é atrelada ao relógio do áudio, então a imagem se forma inteira na tela, na proporção certa.
   - **Congelar** (`F`) e **exportar PNG**.
3. **03 · Extração completa**
   - Carregue o WAV. É lido na **taxa nativa**, porque o `decodeAudioData` reamostraria e destruiria a ortogonalidade. Formatos comprimidos são tentados a 48, 44,1 e 96 kHz.
   - Sai um relatório técnico: posição do beacon, coerência, SNR, EVM, BER pré-ECC, bytes corrigidos, rasuras, blocos falhos, CRC32 e SHA-256.
   - Comparação lado a lado com a original (carregada ou da sessão), com PSNR, SSIM e mapa de diferença.
4. **04 · Laboratório**
   - Testes de resistência: re-quantização, ganho, corte de início, ruído, eco, passa-baixa, simulações de MP3/Opus, reamostragem e **Opus real** via MediaRecorder.
   - Ajustes finos: transição, profundidade do carving, semente.
   - Métricas técnicas da última codificação.

---

## 3. Controle de tempo

**O tempo manda.** Você define a duração, e o planejador testa todas as FFTs (N de 256 a 16384) para achar **a maior resolução que cabe nesse tempo**, preservando a proporção. A conta é física: **pixels ≈ banda × tempo / 1,4**. Por isso, em poucos segundos a imagem precisa ser menor. Uma banda mais larga compensa.

Medidas (imagem de 640×480, 48 kHz):

| Tempo | Banda alta 11–20 kHz | Banda ampla 1–20 kHz |
|---|---|---|
| 3 s | 125×94 | 156×117 |
| 5 s | 145×108 | 268×201 |
| 10 s | 253×190 | 315×236 |
| 20 s | 326×244 | 537×403 |
| nativa 640×480 | ≥ 76 s | ≥ 38 s |

- **Sem hospedeiro**, o arquivo tem exatamente o tempo escolhido (5 s → 5,00 s). Com **"auto"**, vale o comportamento antigo: a resolução nativa manda e a duração pode ficar longa.
- **Com hospedeiro:** a imagem vai para o trecho *[início, início + duração]*. A limpeza da banda (carving) acontece **só nesse trecho**, com transição suave de 50 ms, e o resto da música fica intacto. O decodificador acha o beacon em qualquer posição do arquivo.
- **Exportar só o trecho** recorta o hospedeiro e gera um arquivo curto (ex.: trecho de 6 s de uma música → MP3 de 141 KB).

## 4. Formatos de saída e tamanho do arquivo

Por padrão a saída mantém **o mesmo formato, taxa de amostragem e canais do arquivo original**, para não inchar o tamanho:

| Original | Saída automática | Tamanho medido |
|---|---|---|
| MP3 192 kbps (1,80 MB) | MP3 192 kbps | **1,80 MB (0%)** |
| WAV 16 bits 44,1 kHz (13,2 MB) | WAV 16 bits 44,1 kHz | **13,2 MB (0%)** |
| FLAC 16 bits (3,65 MB) | FLAC 16 bits | 4,06 MB (+11%: a camada embutida comprime menos que música) |
| sem hospedeiro / trilha demo | FLAC 16 bits | ~35–55% de um WAV |

Também dá para escolher manualmente:

| Formato | Perdas | Extração bit a bit | Observação |
|---|---|---|---|
| **FLAC** 16/24 bits | não | **garantida** | Encoder próprio (`core/flac.js`), validado com ffmpeg: decodificação idêntica bit a bit em 22,05/44,1/48/96 kHz |
| **WAV** 16/24/float 32 | não | **garantida** | Maior arquivo |
| **MP3** 128–320 kbps | sim | só no perfil Robusto a **320 kbps** | Codificado pelo **LAME** (lamejs). Até 48 kHz. Corta acima de ≈17–20 kHz conforme o bitrate |

Testes com MP3 **real** (LAME, decodificado pelo navegador):

| Perfil | MP3 320 kbps | MP3 192 kbps | MP3 128 kbps |
|---|---|---|---|
| Visual (11–20 kHz) | imagem visível, arquivo perdido | imagem visível, arquivo perdido | topo cortado, arquivo perdido |
| Robusto (banda "Compatível MP3", 4–15,5 kHz) | **arquivo íntegro** | imagem visível, arquivo perdido | imagem visível, arquivo perdido |

Regra prática: **para guardar a imagem com extração garantida e arquivo pequeno, use FLAC.** Use MP3 quando o tamanho igual ao original importa mais que a extração. A imagem continua visível no espectro.

## 5. Limitações (honestas)

- **Codecs com perdas.** Os codecs reais cortam agudos (MP3 128k ≈ 16 kHz) e quantizam bins fracos.
  - A **imagem visual** costuma sobreviver se a banda estiver abaixo do corte. Use a banda *Média* ou *Ampla* e intensidade maior.
  - A **camada de dados (fase)** é frágil a codecs, porque as células escuras (−DR dB) somem. O ECC forte (RS 25%) ajuda, mas a extração bit a bit é garantida só para **WAV/FLAC sem perdas**.
  - As "simulações" de MP3 e Opus do laboratório são **aproximações perceptuais**, não codecs reais. O teste *Opus real* usa o codificador do navegador.
- **Reamostragem definitiva** para outra taxa (ex.: 48 → 44,1 kHz e o arquivo fica assim) muda o espaçamento dos bins e quebra a grade. A extração falha, embora a imagem continue visível no espectro. Uma ida e volta de boa qualidade (48 → 44,1 → 48) passa intacta.
- **Banda ultrassônica** exige 96 kHz e um player e placa que reproduzam a 96 kHz. Nenhum codec com perdas a preserva. É inaudível, mas também não sobrevive a streaming.
- **Audibilidade.** Em 11–20 kHz a −24 dB a camada é discreta, mas audível como um chiado leve em silêncios e para quem ouve bem agudos. O mascaramento adaptativo ajuda, mas muda o brilho por coluna. Para inaudibilidade real, use 96 kHz e a banda ultrassônica.
- **Visualizadores genéricos** (Audacity, Sonic Visualiser) mostram a imagem. A nitidez máxima depende de usar uma FFT ≈ 2N/rpp. No analisador daqui, *auto* faz isso, e a *grade alinhada* é exata.
- **MP3 não suporta 96 kHz.** Com a banda ultrassônica, o formato automático cai para FLAC.
- A imagem visual é **monocromática**: o espectro só tem magnitude. A cor volta pela camada de dados, na extração completa.
- Arquivos muito longos usam bastante RAM. Tudo fica em `Float32Array`: 3 min a 96 kHz estéreo ≈ 140 MB por cópia.

---

## 6. Arquitetura do código

```
index.html                    UI (4 áreas) + ordem de carga dos scripts
assets/css/main.css           identidade visual (dark-only, verde matrix, mono, scanlines)
assets/js/core/               núcleo DSP: puro, sem DOM, roda na página E nos workers
  fft.js        FFT radix-2, 2 FFTs reais em 1 complexa, janelas
  util.js       CRC32, PRNG mulberry32, permutação, ByteWriter/Reader
  rs.js         Reed–Solomon GF(256): BM + Chien + Forney, erros + rasuras
  layout.js     protocolo SPv2 (beacon, cabeçalho) + planejador de capacidade
  encoder.js    carving STFT, beacon, síntese da grade, nível, mixagem
  decoder.js    localização do beacon, pré-filtro, leitura OFDM, PSK, RS, contêiner
  stft.js       espectrograma de visualização sob demanda (peak-hold, zero-pad, grade alinhada)
  wav.js        WAV 16 (dither TPDF), 24 e float 32 / leitura PCM 8–32 e float
  flac.js       codificador FLAC próprio (preditores fixos, Rice particionado, mid/side, CRC-8/16)
  mp3.js        exportação MP3 via lamejs + leitura da taxa nativa de MP3
  lab.js        degradações + simulação de codec + trilha demo sintetizada
assets/js/vendor/lame.min.js  lamejs 1.2.1 (LAME em JS, LGPL-3.0, sem modificações) + LAME-LICENSE.txt
assets/js/worker-bridge.js    cria Web Workers a partir de fn.toString() → Blob (funciona em file://)
assets/js/ui/
  samples.js    amostra embutida (data URI: evita canvas "contaminado" em file://)
  colormaps.js  Matrix, Thermal, Plasma, Classic, Ice
  media.js      imagens → luminância, payload (original ou WebP ajustado), áudio, Player, PSNR/SSIM
  spectro-view.js  componente de espectrograma (zoom/pan, LUT, cascata ao vivo, congelar, PNG)
  fx.js         chuva digital, glitch, relógio (respeita prefers-reduced-motion)
  app.js        orquestração das 4 abas; 3 workers (job, view, lab)
```

**Workers em `file://`.** Os módulos do núcleo são funções `SPX_xxx(SPX)` registradas em `self.SPX_MODULES`. A página as executa diretamente. O bridge serializa cada função com `toString()`, concatena tudo num Blob e cria o Worker a partir dele. Assim não há `importScripts` nem ES modules, que falham em `file://`.

**Formato do payload** (contêiner `SPXF`): `magic | flags | mime | nome | largura | altura | tamanho | CRC32 | bytes`. Ele é preenchido até blocos RS completos, codificado, intercalado, permutado e "embranquecido" (XOR com PRNG da semente).

## 7. Testes executados
Laboratório no navegador (perfil **Robusto**, 48 kHz, banda 11–18,5 kHz, glifo 560×640 nativo, trilha demo de 90 s):

| Degradação | Beacon | Arquivo (bit a bit) | PSNR luma |
|---|---|---|---|
| Referência / re-quantização 16 bits / ganho −6 dB | ✓ | íntegro, BER 0 | 59 dB |
| Corte de 0,37 s no início + atraso | ✓ | íntegro | 59 dB |
| Ruído branco SNR 40 dB | ✓ | íntegro (3 bytes corrigidos) | 30 dB |
| Eco 80 ms −12 dB | ✓ | íntegro (1224 bytes corrigidos) | 26 dB |
| MP3 320 kbps (simulação) | ✓ | íntegro | 34 dB |
| Reamostragem ida e volta 48 ↔ 44,1 kHz | ✓ | íntegro | 59 dB |
| Ruído branco SNR 25 dB / Opus 64 (simulação) | ✓ | perdido | 18 / 32 dB (imagem visível) |

Na banda ultrassônica (96 kHz), passa-baixa e codecs eliminam tudo, como esperado.

- RS: 2000 blocos aleatórios com erros e rasuras no limite: 2000/2000 corretos.
- Ponta a ponta (Node), com hospedeiro tonal + ruído e carving:
  - 48 kHz/24 bits: PSNR de luma 45,5 dB, CRC ok.
  - 44,1 kHz 8-PSK: CRC ok.
  - Áudio cortado: CRC ok.
  - 96 kHz **1024×1024 nativo**: 49 dB, 1 bit corrigido, CRC ok.
- Navegador (Chromium, `file://`): codificar, analisar (detecção + enquadramento), extrair e obter arquivo idêntico bit a bit; laboratório completo.

## Créditos
Exportação MP3: [LAME](https://lame.sourceforge.io) via [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0), usado como biblioteca separada e sem modificações.

Reescrita completa do [Spectrum](https://github.com/rxrichard/spectrum) de Richard Bastos, que deriva do [img-encode](https://github.com/alexadam/img-encode) de Alex Adam. Licença MIT (ver `LICENSE.md`). Mona Lisa: domínio público.
