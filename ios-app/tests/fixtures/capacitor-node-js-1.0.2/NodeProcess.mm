/*
 * Objective-C++ bridge between the Swift plugin layer and Node.js.
 * This replaces the JNI layer (native-lib.cpp) used on Android.
 */

#import "NodeProcess.h"
#include "bridge.h"

#include <string>
#include <cstring>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <os/log.h>

// NodeMobile.xcframework provides node_start().
// Forward-declare instead of framework import for SPM compatibility.
extern "C" int node_start(int argc, char *argv[]);

static os_log_t nodeLog;
static NodeProcess *sharedInstance = nil;

// C callback invoked by bridge.cpp when Node.js sends a message to native.
void receiveMessageFromNode(const char* channelName, const char* channelMessage)
{
    if (!sharedInstance || !sharedInstance.delegate)
        return;

    NSString *channel = [NSString stringWithUTF8String:channelName];
    NSString *message = [NSString stringWithUTF8String:channelMessage];

    // Dispatch to main queue for safe Capacitor plugin access
    dispatch_async(dispatch_get_main_queue(), ^{
        [sharedInstance.delegate didReceiveMessageOnChannel:channel message:message];
    });
}

// ---- stdout/stderr redirection to os_log ----

static int stdoutPipe[2];
static int stderrPipe[2];

static void *stdoutThreadFunc(void *)
{
    ssize_t readSize;
    char buf[2048];
    while ((readSize = read(stdoutPipe[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[readSize - 1] == '\n')
            --readSize;
        buf[readSize] = 0;
        os_log_info(nodeLog, "%{public}s", buf);
    }
    return nullptr;
}

static void *stderrThreadFunc(void *)
{
    ssize_t readSize;
    char buf[2048];
    while ((readSize = read(stderrPipe[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[readSize - 1] == '\n')
            --readSize;
        buf[readSize] = 0;
        os_log_error(nodeLog, "%{public}s", buf);
    }
    return nullptr;
}

static int startRedirectingStdoutStderr()
{
    setvbuf(stdout, NULL, _IONBF, 0);
    pipe(stdoutPipe);
    dup2(stdoutPipe[1], STDOUT_FILENO);

    setvbuf(stderr, NULL, _IONBF, 0);
    pipe(stderrPipe);
    dup2(stderrPipe[1], STDERR_FILENO);

    pthread_t stdoutThread, stderrThread;

    if (pthread_create(&stdoutThread, NULL, stdoutThreadFunc, NULL) != 0)
        return -1;
    pthread_detach(stdoutThread);

    if (pthread_create(&stderrThread, NULL, stderrThreadFunc, NULL) != 0)
        return -1;
    pthread_detach(stderrThread);

    return 0;
}

// ---- NodeProcess implementation ----

@implementation NodeProcess

- (void)startWithArguments:(NSArray<NSString *> *)arguments
      environmentVariables:(NSDictionary<NSString *, NSString *> *)env
{
    nodeLog = os_log_create("net.hampoelz.capacitor.nodejs", "NodeJS-Engine");
    sharedInstance = self;

    // Set environment variables
    [env enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
        setenv([key UTF8String], [value UTF8String], 1);
    }];

    // Register callback for messages from Node.js → native
    RegisterCallback(&receiveMessageFromNode);

    // Redirect stdout/stderr to os_log
    if (startRedirectingStdoutStderr() == -1) {
        os_log_error(nodeLog, "Failed to redirect stdout/stderr to os_log.");
    }

    // Convert NSArray to contiguous argc/argv (required by libuv)
    int argc = (int)[arguments count];

    size_t argsSize = 0;
    for (NSString *arg in arguments) {
        argsSize += strlen([arg UTF8String]) + 1;
    }

    char *argsBuffer = (char *)calloc(argsSize, sizeof(char));
    char **argv = (char **)malloc(argc * sizeof(char *));
    char *currentPos = argsBuffer;

    for (int i = 0; i < argc; i++) {
        const char *argStr = [arguments[i] UTF8String];
        size_t len = strlen(argStr);
        strncpy(currentPos, argStr, len);
        argv[i] = currentPos;
        currentPos += len + 1;
    }

    os_log_info(nodeLog, "Starting Node.js engine with %d arguments.", argc);

    // Start Node.js — this blocks until the engine exits
    node_start(argc, argv);

    free(argv);
    free(argsBuffer);
}

- (void)sendToChannel:(NSString *)channel message:(NSString *)message
{
    SendMessageToNode([channel UTF8String], [message UTF8String]);
}

@end
