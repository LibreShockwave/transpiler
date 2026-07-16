cmake_minimum_required(VERSION 3.20)

project(libreshockwave_transpiler LANGUAGES CXX)

# LibreShockwave is vendored as a submodule. It provides the Director parser/player
# library (target LibreShockwave::libreshockwave) that the exporter probe links.
# LibreShockwave no longer builds the transpiler itself; this repo owns the exporter.
add_subdirectory(external/LibreShockwave)

# The transpiler's own exporter probe: a read-only pass over the parsed movie model that
# emits a self-contained TypeScript/PixiJS project. It compiles against the LibreShockwave
# library and reads the template dirs below (paths baked in at configure time, used at run
# time when copying the project skeleton + hand-written runtime into each export).
add_executable(libreshockwave_export_ts ExportTsProbe.cpp)
target_link_libraries(libreshockwave_export_ts PRIVATE LibreShockwave::libreshockwave)
target_compile_features(libreshockwave_export_ts PRIVATE cxx_std_20)
target_compile_definitions(libreshockwave_export_ts PRIVATE
    LIBRESHOCKWAVE_TS_EXPORT_TEMPLATE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/export-template"
    LIBRESHOCKWAVE_TS_RUNTIME_TEMPLATE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/runtime-template/src"
)
set_target_properties(libreshockwave_export_ts PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")