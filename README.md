# SillyTavern iOS

**iPhone·iPad에서 실행하는 SillyTavern 비공식 앱입니다.** 웹 화면과 서버가 기기 안에서 실행되므로 별도의 PC 서버를 계속 켜 둘 필요가 없습니다. SillyTavern **1.19.0**을 기반으로 합니다.

AI 모델은 포함되어 있지 않습니다. 대화에는 원격 LLM API 또는 연결 가능한 개인 서버가 필요하며, 서비스에 따라 이용 요금이 발생할 수 있습니다.

[IPA 다운로드](https://github.com/p16481012/SillyTaevrn-ios/releases) · [Mac 설치](#mac-install) · [Windows 설치](#windows-install) · [사용 안내](docs/README.md) · [오류 제보](https://github.com/p16481012/SillyTaevrn-ios/issues/new/choose)

## 설치하기

| 환경 | 설치 방법 |
| --- | --- |
| Mac | Xcode에서 소스를 직접 빌드·서명·설치 |
| Windows | 배포된 IPA를 Sideloadly·AltStore로 서명·설치 |

Mac에서도 IPA 설치를 선택할 수 있습니다. 두 경로 모두 본인의 Apple 계정이 필요합니다. 현재는 **GitHub 시험판**으로 배포하며, App Store·TestFlight 배포는 제공하지 않습니다. 최소 OS는 iOS·iPadOS 15.0으로 설정되어 있으나 기기·OS에 따라 호환성 차이가 있을 수 있습니다.

<a id="mac-install"></a>

### Mac: Xcode 직접 빌드

macOS, **Xcode 26 이상**, **Node.js 22 이상**과 iPhone·iPad를 준비하세요. Xcode는 기기에 설치된 OS를 지원하는 버전을 사용하고, 처음 실행할 때 약관 동의와 추가 구성요소 설치를 마칩니다.

```sh
git clone https://github.com/p16481012/SillyTaevrn-ios.git
cd SillyTaevrn-ios
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix ios-app ci --ignore-scripts --no-audit --no-fund
npm --prefix ios-app/nodejs-project ci --ignore-scripts --no-audit --no-fund
npm --prefix ios-app run sync:ios
npm --prefix ios-app run open
```

1. 기기를 연결하고 **이 컴퓨터를 신뢰**합니다. Xcode 계정 설정에 Apple 계정을 추가합니다.
2. `App` 대상의 **Signing & Capabilities**에서 자동 서명을 켜고 **Team**에 본인의 계정을 선택합니다.
3. 실행 대상으로 연결한 기기를 선택하고 **▶ Run**을 누릅니다. 기기에서 개발자 신뢰·개발자 모드를 요구하면 설정을 완료합니다.

[상세 빌드 안내](ios-app/BUILDING.md)

<a id="windows-install"></a>

### Windows: IPA 설치

1. [Releases](https://github.com/p16481012/SillyTaevrn-ios/releases)의 **Assets**에서 `.ipa` 파일을 받습니다. `Source code (zip)`은 설치 파일이 아닙니다.
2. [설치 안내](docs/installation.md)에 따라 Sideloadly 또는 AltStore와 Apple 기기 드라이버를 준비합니다.
3. iPhone·iPad를 연결하고 IPA를 본인의 Apple 계정으로 서명·설치합니다.

IPA는 **서명되지 않은 파일**이므로 iPhone에서 파일을 누르는 것만으로 설치되지 않습니다. 무료 Apple 계정으로 서명한 앱은 일반적으로 **7일마다 갱신**이 필요하며, Xcode 직접 설치에도 적용됩니다. [Apple 계정별 안내](https://developer.apple.com/support/compare-memberships/)

## 주요 기능

- SillyTavern 채팅 화면, 스트리밍 응답, 대화 저장·재실행 복원
- 캐릭터 카드·설정집·프리셋·대화 가져오기와 내보내기
- OpenAI·Claude·Gemini·OpenRouter 등 원격 API 연결
- 파일 앱에서 사용자 자료 접근, 전체 자료 ZIP 내보내기, 설정 스냅샷
- HTTP/HTTPS Git 저장소를 통한 확장 설치·업데이트·브랜치 전환
- iOS 키보드·슬라이더·화면 가장자리 대응, 좁은 화면의 메시지 버튼 줄바꿈

## 데이터와 백업

자료는 앱의 `Documents/SillyTavern`에 저장됩니다. 파일 앱의 **나의 iPhone/iPad → SillyTavern**에서 접근할 수 있으며, 자동 iCloud 동기화는 제공하지 않습니다.

업데이트·재서명 전에는 필요한 자료를 앱 밖에 백업하세요. **전체 ZIP의 일괄 복원은 지원하지 않습니다.** 개별 자료 가져오기와 설정 스냅샷 복원 방법은 [데이터 이동 안내](docs/installation.md#데이터-가져오기와-백업)를 참고하세요.

API 키는 사용자 폴더의 `secrets.json`에 저장됩니다. 사용자 폴더를 직접 복사한 백업에는 키와 개인 대화가 포함될 수 있으므로 공유하지 마세요. [보안 안내](SECURITY.md)

## 알아둘 점

- 내장 Node 서버는 **JIT 없이 실행**합니다. 서버 계산은 데스크톱보다 느릴 수 있지만, 원격 AI의 응답 생성은 연결한 제공자가 처리합니다.
- 로컬 LLM·이미지 캡션·음성 인식·음성 합성 엔진은 포함하지 않습니다.
- 외부 실행 파일이나 네이티브 모듈이 필요한 확장은 동작하지 않을 수 있습니다. [확장 안내](docs/extension-management.md)
- 일부 모델의 토큰 수는 추정값을 사용합니다. 서버의 WebP/AVIF 처리와 PAC 프록시 스크립트는 지원하지 않습니다.
- 업로드·JSON/form 요청 한도는 **32 MiB**입니다. iOS 특성상 장시간 백그라운드 실행은 보장하지 않습니다.

## 문서와 기여

[설치·업데이트](docs/installation.md) · [문제 해결](docs/diagnostics.md) · [소스 빌드](ios-app/BUILDING.md) · [앱 구조](ios-app/IOS-PORT.md) · [기여 안내](CONTRIBUTING.md)

## 원본과 라이선스

이 프로젝트는 [SillyTavern](https://github.com/SillyTavern/SillyTavern)과 [elouannd의 iOS 포트](https://github.com/elouannd/SillyTavern-foriOS)를 바탕으로 합니다. SillyTavern 공식 iOS 앱이 아닙니다.

라이선스는 [GNU AGPL v3](LICENSE)이며 원본 소스와 의존성의 저작권·라이선스 고지를 유지합니다.
