cmake_minimum_required(VERSION 3.20)

project(libreshockwave_transpiler LANGUAGES CXX)

# LibreShockwave is vendored as a submodule. It provides the Director parser/player
# library (target LibreShockwave::libreshockwave) that the exporter probe links.
# LibreShockwave no longer builds the transpiler itself; this repo owns the exporter.
add_subdirectory(external/LibreShockwave)

# The transpiler's own exporter probe: a read-only pass over the parsed movie model that
# emits a self-contained TypeScript/PixiJS project. It compiles against the LibreShockwave
# library and reads the single runtime source tree below (path baked in at configure time).
add_executable(libreshockwave_export_ts ExportTsProbe.cpp)
target_link_libraries(libreshockwave_export_ts PRIVATE LibreShockwave::libreshockwave)
target_compile_features(libreshockwave_export_ts PRIVATE cxx_std_20)
target_compile_definitions(libreshockwave_export_ts PRIVATE
    LIBRESHOCKWAVE_TS_RUNTIME_DIR="${CMAKE_CURRENT_SOURCE_DIR}/runtime"
)
set_target_properties(libreshockwave_export_ts PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
