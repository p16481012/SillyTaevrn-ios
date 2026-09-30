# iOS 소스 빌드

Mac에서 앱을 직접 빌드하거나 서명 없는 IPA를 만드는 방법입니다. 배포된 IPA를 설치하려면 [설치 안내](../docs/installation.md)를, 내부 구조를 살펴보려면 [iOS 구현 구조](IOS-PORT.md)를 참고하세요.

## 준비 환경

| 항목 | 요구 사항 |
| --- | --- |
| 앱 버전 / 빌드 | SillyTavern 1.19.0 / 10194 |
| 빌드용 Node.js | 22 이상 |
| 네이티브 빌드 | macOS, Xcode 26 이상, Xcode Command Line Tools |
| 고정 의존성 | Capacitor 8.3.0, `@choreruiz/capacitor-node-js` 1.0.2 |
| 앱 내부 런타임 | Node 18.20.4 / ABI 108, JIT 없이 실행 |
| 최소 OS 선언 | iOS·iPadOS 15.0 |

Xcode는 연결할 기기의 OS를 지원하는 버전을 사용하세요. 최초 실행 시 약관 동의와 추가 구성요소 설치를 마치고, **Xcode → Settings → Locations → Command Line Tools**에서 사용할 Xcode를 선택합니다. 현재 CI의 도구 버전은 Xcode 26.3과 Node 24.14.0입니다. 프로젝트는 Swift Package Manager를 사용하므로 CocoaPods를 별도로 설치할 필요는 없습니다.

## 1. 소스와 의존성 준비

터미널에서 실행합니다. 이후 명령도 저장소 루트에서 실행하세요.

```sh
git clone --branch main https://github.com/p16481012/SillyTaevrn-ios.git
cd SillyTaevrn-ios
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix ios-app ci --ignore-scripts --no-audit --no-fund
npm --prefix ios-app/nodejs-project ci --ignore-scripts --no-audit --no-fund
```

세 의존성 묶음 모두 필요합니다. lockfile에 고정한 버전으로 설치하며, npm lifecycle script는 실행하지 않습니다.

<a id="macos-app-build"></a>

## 2. Xcode에서 직접 설치

```sh
npm --prefix ios-app run sync:ios
npm --prefix ios-app run open
```

`sync:ios`는 프런트엔드·서버 파일을 빌드하고 Capacitor 프로젝트를 동기화합니다. `open`은 준비된 Xcode 프로젝트를 엽니다.

1. Xcode에 본인의 Apple 계정을 추가합니다.
2. 프로젝트의 **App 대상 → Signing & Capabilities**에서 **Automatically manage signing**을 켜고 본인 **Team**을 선택합니다.
3. 기기를 연결해 잠금을 풀고 컴퓨터를 신뢰합니다. Xcode 상단에서 **App** scheme과 연결한 기기를 선택합니다.
4. **Run(▶)**을 누릅니다. 기기에서 개발자 신뢰나 개발자 모드를 요구하면 안내에 따라 설정합니다.

앱 식별자 `com.sillytavern.ios`를 등록할 수 없다면 본인용 **Bundle Identifier**를 지정해야 할 수 있습니다. 이후 업데이트에는 같은 서명 팀과 식별자를 유지하세요. 기존 앱을 삭제하거나 식별자를 바꾸기 전에는 [백업·업데이트 안내](../docs/installation.md)를 확인합니다. Simulator에서 실행할 때는 Apple 계정 서명이 필요하지 않습니다.

<a id="asset-preparation"></a>

## 소스를 수정한 뒤

Mac에서는 `sync:ios`를 다시 실행한 뒤 Xcode에서 빌드합니다. Windows에서는 앞의 의존성을 설치한 뒤 다음 명령으로 프런트엔드·서버 파일만 준비할 수 있습니다. iPhoneOS 앱 빌드에는 macOS/Xcode 또는 GitHub Actions가 필요합니다.

```sh
npm --prefix ios-app run prepare:ios
```

준비 스크립트는 의존성을 자동 설치하지 않습니다. 서버 번들, 토크나이저 자료, 라이선스 고지, 런타임 manifest를 만들고 `ios-app/ios/App/App/public`에 배치합니다. Node 브리지 수정은 고정 버전과 소스 해시를 확인한 뒤 적용합니다. 버전 불일치 오류가 나면 의존성 변경 내용을 확인하세요.

`ios-app/nodejs-project`의 bootstrap·adapter와 루트 `src`, `public`, `default`가 수정 대상입니다. `nodejs-project-deploy`, 복사된 `nodejs-project/src`, `server-bundle.mjs`, Xcode의 `public`은 생성물이므로 직접 편집하지 않습니다. `prepare-ios.sh`는 같은 Node 준비 스크립트를 호출하는 호환 진입점입니다.

## 서명 없는 IPA 만들기

Mac에서 `sync:ios`를 완료한 뒤 실행합니다. 아래 예시는 저장소 옆에 빌드·IPA 폴더를 만듭니다. IPA 출력 폴더는 새 폴더이거나 비어 있어야 합니다.

```sh
xcodebuild -project ios-app/ios/App/App.xcodeproj -scheme App \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$PWD/../SillyTaevrn-ios-build" \
  PRODUCT_BUNDLE_IDENTIFIER=com.sillytavern.ios \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
node ios-app/scripts/package-unsigned-device.mjs \
  --app "$PWD/../SillyTaevrn-ios-build/Build/Products/Release-iphoneos/App.app" \
  --output-root "$PWD/../SillyTaevrn-ios-ipa"
```

패키징 도구는 앱 버전·식별자·런타임 파일을 확인하고 IPA와 SHA-256을 포함한 메타데이터를 만듭니다. 위 명령은 패키징 도구가 요구하는 원래 앱 식별자로 빌드합니다. **생성된 IPA는 설치 전에 별도로 서명해야 합니다.** 소스에 서명 인증서, 프로비저닝 프로파일이나 사용자 자료를 추가하지 마세요.

GitHub Actions의 수동 [iOS unsigned device build only](../.github/workflows/ios-device-build.yml)로도 만들 수 있습니다. 결과는 `ios-unsigned-device-build-실행ID` artifact에 7일 보관됩니다. 이 워크플로는 Release 게시나 실기기 실행을 자동으로 수행하지 않습니다.

## 테스트 실행

의존성과 앱 자료를 준비한 뒤 실행합니다.

```sh
npm --prefix tests install --ignore-scripts --package-lock=false --no-audit --no-fund
npm --prefix tests run test:unit -- --runInBand
node --experimental-vm-modules --test --test-concurrency=1 ios-app/tests/*.test.mjs
```

8000번 포트를 쓰는 통합 검사는 순서대로 실행합니다. 내장 런타임 대상으로 검사하려면 `ST_TEST_NODE`에 Node 18.20.4 실행 파일의 절대 경로를 지정하고, 브라우저를 사용하는 항목에는 `ST_CHROMIUM_PATH`를 지정합니다. 필요한 환경이 없으면 일부 항목이 건너뛰어질 수 있습니다.

Simulator UI·채팅·데이터 검사는 [통합 워크플로](../.github/workflows/ios-pre-device-validation.yml)와 각각의 [UI](../.github/workflows/ios-ui-validation.yml), [채팅](../.github/workflows/ios-chat-validation.yml), [데이터](../.github/workflows/ios-data-validation.yml) 워크플로에서 실행할 수 있습니다. 호스트·Simulator 결과만으로 실제 기기의 설치·권한·키보드·백그라운드 동작까지 확인된 것은 아닙니다.

<a id="runtime-capabilities"></a>

## 지원 기능과 제약

| 기능 | 현재 구현 |
| --- | --- |
| 토큰화 | JavaScript OpenAI BPE. SentencePiece·Hugging Face JSON 모델(Claude·Llama 3 포함)은 추정값 |
| 이미지 | PNG/JPEG 처리와 캐릭터 카드 메타데이터 보존. 서버 WebP/AVIF 코덱 미지원 |
| 벡터 | 기기에 보존되는 인덱스와 지원되는 원격 embedding 제공자 |
| 확장 Git | HTTP/HTTPS 설치·업데이트·브랜치 관리. SSH 미지원 |
| 프록시 | HTTP/HTTPS/SOCKS. PAC 스크립트 미지원 |
| 로컬 추론 | 로컬 LLM·Transformers·로컬 음성 엔진 미포함 |
| 외부 프로그램 | 시스템 실행 파일과 임의 네이티브 애드온 미지원 |
| 요청 크기 | 업로드 파일과 JSON/form 본문 32 MiB 한도 |

확장별 요구 기능에 따라 호환성이 다릅니다. [확장 관리](../docs/extension-management.md)에서 업데이트와 브랜치 전환의 조건을 확인하세요. 전체 자료 ZIP은 내보내기를 지원하며 ZIP 통째 자동 복원과 자동 iCloud 동기화는 제공하지 않습니다.

iOS는 배경 이미지의 평균색 계산을 기본 생략합니다. 치수·애니메이션·해시는 유지하며, 사용자 `config.yaml`의 `imageMetadata.dominantColor`를 `true`로 설정하면 평균색 계산과 그 처리 비용이 복원됩니다.
