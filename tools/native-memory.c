#define _GNU_SOURCE
#include <node_api.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <gnu/libc-version.h>
#include <dlfcn.h>
#include <stdint.h>

typedef int (*mallctl_fn)(const char *, void *, size_t *, void *, size_t);
static napi_value allocator_stats(napi_env env, napi_callback_info info) {
  napi_value object, value;
  napi_create_object(env, &object);
  Dl_info library = {0};
  dladdr(dlsym(RTLD_DEFAULT, "malloc"), &library);
  napi_create_string_utf8(env, library.dli_fname ? library.dli_fname : "unknown", NAPI_AUTO_LENGTH, &value);
  /* This can be the executable's canonical PLT entry, not the allocator provider. */
  napi_set_named_property(env, object, "mallocSymbolImage", value);
  mallctl_fn mallctl = (mallctl_fn)dlsym(RTLD_DEFAULT, "mallctl");
  napi_create_string_utf8(env, mallctl ? "jemalloc" : "glibc", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "implementation", value);
  if (!mallctl) return object;
  uint64_t epoch = 1;
  size_t length = sizeof(epoch);
  if (mallctl("epoch", &epoch, &length, &epoch, sizeof(epoch))) {
    napi_throw_error(env, NULL, "jemalloc epoch failed"); return NULL;
  }
  const char *version;
  length = sizeof(version);
  if (mallctl("version", &version, &length, NULL, 0)) {
    napi_throw_error(env, NULL, "jemalloc version failed"); return NULL;
  }
  napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "version", value);
  const char *names[] = {"allocated", "active", "resident", "mapped", "retained"};
  for (size_t i = 0; i < 5; i++) {
    size_t bytes;
    char key[64];
    snprintf(key, sizeof(key), "stats.%s", names[i]);
    length = sizeof(bytes);
    if (mallctl(key, &bytes, &length, NULL, 0)) {
      napi_throw_error(env, NULL, "jemalloc stats unavailable"); return NULL;
    }
    napi_create_double(env, (double)bytes, &value);
    napi_set_named_property(env, object, names[i], value);
  }
  return object;
}

/* Optional Linux/glibc diagnostic, compiled explicitly in the isolated test image. */
static napi_value snapshot(napi_env env, napi_callback_info info) {
  char *xml = NULL;
  size_t length = 0;
  FILE *stream = open_memstream(&xml, &length);
  if (!stream) {
    napi_throw_error(env, NULL, "open_memstream failed");
    return NULL;
  }
  int result = malloc_info(0, stream);
  int closed = fclose(stream);
  if (result || closed) {
    free(xml);
    napi_throw_error(env, NULL, "malloc_info failed");
    return NULL;
  }
  napi_value value;
  napi_status status = napi_create_string_utf8(env, xml, length, &value);
  free(xml);
  if (status != napi_ok) {
    napi_throw_error(env, NULL, "Cannot create allocator snapshot");
    return NULL;
  }
  return value;
}

static napi_value trim(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_get_boolean(env, malloc_trim(0) != 0, &value);
  return value;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL},
    {"trim", NULL, trim, NULL, NULL, NULL, napi_default, NULL},
    {"allocatorStats", NULL, allocator_stats, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 3, methods);
  napi_value version;
  napi_create_string_utf8(env, gnu_get_libc_version(), NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "glibc", version);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
