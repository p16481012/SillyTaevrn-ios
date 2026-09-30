# iOS 구현 구조

앱은 SillyTavern의 화면과 Node 서버를 iPhone·iPad 안에서 함께 실행합니다. AI 응답은 사용자가 설정한 원격 제공자 또는 접근 가능한 로컬 네트워크 서버에 요청합니다. 빌드 명령은 [소스 빌드](BUILDING.md), 사용 방법은 [문서 목록](../docs/README.md)에 있습니다.

## 구성

```text
iPhone / iPad 앱
├─ Swift / Capacitor
│  ├─ 런타임 설치·무결성 확인
│  ├─ 시작 상태와 앱 복귀 처리
│  └─ WKWebView → http://localhost:8000
└─ nodejs-mobile / Node 18.20.4
   ├─ SillyTavern 서버와 iOS 호환 구현
   ├─ Documents/SillyTavern 사용자 자료
   └─ 사용자가 설정한 원격 API
```

Capacitor는 8.3.0, Node 플러그인은 1.0.2에 고정합니다. 빌드 도구에는 Node 22 이상을 사용하지만 앱의 서버는 내장 Node 18.20.4 / ABI 108을 대상으로 생성합니다. 내장 서버는 JIT 없이 실행하며, 원격 모델의 추론은 연결한 서버에서 수행합니다.

## 주요 소스

| 경로 | 역할 |
| --- | --- |
| `src/`, `public/`, `default/` | 서버·화면·기본 자료 |
| `ios-app/nodejs-project/server-ios.js` | 경로·설정·로그 초기화와 서버 시작 |
| `ios-app/nodejs-project/server-ios-entry.js` | 본체의 준비 완료를 기다리는 번들 진입점 |
| `ios-app/nodejs-project/adapters/` | 토큰화·이미지·Git·벡터 등 iOS 호환 구현 |
| `ios-app/scripts/prepare-ios.mjs` | 의존성 확인·앱 자료 준비·Capacitor 동기화 |
| `ios-app/scripts/bundle-server.mjs` | esbuild 서버 번들과 의존성 검사 |
| `ios-app/scripts/runtime-manifest.mjs` | 런타임 파일 목록과 해시 |
| `ios-app/ios/App/App/AppDelegate.swift` | 런타임 설치·교체 복구와 경로 설정 |
| `ios-app/ios/App/App/SillyTavernViewController.swift` | 서버·화면 준비 확인, 앱 복귀·WebView 복구, 진단 공유 |
| `ios-app/ios/App/App/DiagnosticsExport.swift` | 진단 JSON 생성 |
| `public/scripts/ios-init.js`, `public/css/ios-overrides.css` | iOS 화면 초기화·키보드·safe area·메시지 도구 배치 |
| `public/scripts/ios-capability-ui.js` | 미지원 로컬 기능의 선택 제어와 안내 |

프런트엔드 라이브러리는 webpack, 서버는 `node18` 대상 esbuild 번들로 미리 빌드합니다. 준비 단계에서 네이티브/WASM 의존성과 미해결 import를 확인하고, 토크나이저 자료·라이선스 고지·manifest를 생성합니다. 고정된 Node 브리지 소스에는 버전·해시 확인 후 호환성 수정을 적용합니다.

`nodejs-project-deploy`, 복사된 `nodejs-project/src`, `server-bundle.mjs`, `ios-app/ios/App/App/public`은 생성 결과입니다. 원본을 수정한 뒤 `prepare:ios` 또는 macOS의 `sync:ios`로 다시 만듭니다.

## 파일 보관

| 위치 | 내용 |
| --- | --- |
| 앱 번들 `public/` | 미리 빌드한 화면, 서버 배포 파일, 기본 자료 |
| `Documents/SillyTavern/` | 사용자 설정·캐릭터·대화 등 |
| `Library/nodejs/public/` | 기기에 설치한 서버 런타임 |
| `Library/nodejs/public.pending/` | 교체 준비 중인 런타임 |
| `Library/nodejs/public.previous/` | 교체 복구용 이전 런타임 |
| `Library/Application Support/st_config.json` | 네이티브 경로·앱 버전·배포 정보 |
| `Library/Application Support/logs/` | 크기를 제한한 내부 시작 로그 |

읽기 전용 앱 번들과 사용자 자료를 분리합니다. `Documents/SillyTavern/config.yaml`은 없을 때만 기본값에서 만들며, 런타임 교체 시 사용자 자료 폴더를 교체하지 않습니다.

사용자 폴더는 Files 앱에서 접근할 수 있습니다. 자동 iCloud 동기화는 구현하지 않았으며, 사용자 폴더의 `secrets.json`은 현재 Keychain 저장을 사용하지 않습니다. 데이터 이동은 [설치·백업 안내](../docs/installation.md), 민감한 자료 취급은 [보안 안내](../SECURITY.md)를 참고하세요.

## 시작과 복구

1. `AppDelegate`가 런타임 manifest와 파일 해시를 확인합니다. 교체가 필요하면 `public.pending`에서 준비한 뒤 설치하고, 중단된 교체는 `public.previous`를 이용해 복구합니다.
2. Swift가 경로·버전·배포 ID를 기록하고 Node를 시작합니다. 서버는 해당 정보와 기본 파일을 확인하고, 사용자 설정·loopback 주소·CSRF를 설정합니다.
3. 서버의 초기화 promise가 끝난 뒤 Swift가 `/api/ios/health`의 준비 상태·버전·배포 ID를 확인합니다.
4. WebView를 열고 실제 프런트엔드 `APP_READY`를 기다립니다. 최초 안내에서 사용자 입력이 필요한 상태는 따로 처리합니다.

manifest는 런타임 파일의 경로·SHA-256·크기를 포함합니다. JavaScript와 Swift는 경로를 UTF-16 코드 단위 순서로 정렬하여 같은 배포 ID를 계산합니다.

앱 복귀 시 서버와 화면 상태를 다시 확인하고, WebView 프로세스가 종료되면 재연결 절차를 수행합니다. iOS의 앱 정지·메모리 관리에 따라 장시간 백그라운드 실행은 보장되지 않습니다.

## 호환 기능과 진단

JavaScript OpenAI BPE, PNG/JPEG 처리, 영속 벡터 인덱스, HTTP/HTTPS 확장 Git을 제공합니다. 로컬 LLM·Transformers·로컬 음성 엔진, 외부 실행 파일, 임의 네이티브 애드온 등은 지원하지 않습니다. 토큰 수 추정과 파일 형식·용량 한도를 포함한 [지원 기능과 제약](BUILDING.md#runtime-capabilities), [확장 관리](../docs/extension-management.md)를 확인하세요.

내부 시작 로그는 크기를 제한해 순환 보관합니다. 공유용 진단 JSON은 허용된 앱 정보와 시작 사건으로 구성하며 사용자 설정·대화·API 키 파일을 읽지 않습니다. 내용과 내보내기 방법은 [진단 안내](../docs/diagnostics.md)에 있습니다.
